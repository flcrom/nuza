//! Filesystem calls with a deadline.
//!
//! A vault on iCloud Drive, Dropbox or an SMB share can have a single `stat`
//! block for as long as the provider takes to answer - or for good, on a
//! placeholder that is offline. Nothing in `std::fs` can be told to give up, so
//! a listing that makes the call itself is only as fast as its slowest file.
//!
//! These calls are made on a small pool of threads instead, and the caller
//! waits for them only until a deadline. A call that has not come back by then
//! is left to finish (or not) on its thread, and the caller carries on without
//! it: the row it was for is shown as unavailable, and the rest of the folder
//! is not held up.

use std::cell::Cell;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Threads the pool keeps. Enough that a few stuck calls leave the rest
/// working, few enough that a vault of ten thousand files does not spawn
/// ten thousand of anything.
const WORKERS: usize = 8;

/// The most threads the pool will ever have. A call that has been abandoned
/// still holds its thread until the OS lets go of it, so the pool is topped
/// back up with fresh ones - but not without end, or an offline mount with a
/// thousand files in it would leave a thousand threads behind.
const MAX_WORKERS: usize = 48;

struct Task {
    run: Box<dyn FnOnce() + Send>,
    /// Set once the caller has stopped waiting, so a task that was still
    /// queued behind stuck ones is dropped rather than run for nobody.
    abandoned: Arc<AtomicBool>,
    /// How many of the caller's tasks a thread has picked up, so that what is
    /// stuck can be told from what is merely still queued.
    started: Arc<AtomicUsize>,
}

/// What is waiting for a thread, in two lanes. Whatever someone is waiting on
/// right now - a folder being opened, a rename being taken account of - goes
/// before the reads a vault-wide scan queues up by the thousand: in one lane,
/// a single `stat` for a rename waited behind every note in the vault, three
/// seconds in a large one, and was then given up on.
#[derive(Default)]
struct Queues {
    urgent: VecDeque<Task>,
    background: VecDeque<Task>,
}

struct Pool {
    queues: Mutex<Queues>,
    /// Signalled whenever a task is queued.
    queued: Condvar,
    /// Threads alive now, including any busy with a call that never returned.
    live: AtomicUsize,
    /// Threads with nothing to do. When there are none, a request would wait
    /// behind calls that may never return, so another thread is started.
    idle: AtomicUsize,
}

fn pool() -> &'static Pool {
    static POOL: OnceLock<Pool> = OnceLock::new();
    static STARTED: OnceLock<()> = OnceLock::new();

    let pool = POOL.get_or_init(|| Pool {
        queues: Mutex::new(Queues::default()),
        queued: Condvar::new(),
        live: AtomicUsize::new(0),
        idle: AtomicUsize::new(0),
    });
    STARTED.get_or_init(|| grow(pool, WORKERS));
    pool
}

/// Starts up to `count` more threads, within `MAX_WORKERS`.
fn grow(pool: &'static Pool, count: usize) {
    for _ in 0..count {
        let live = pool.live.load(Ordering::SeqCst);
        if live >= MAX_WORKERS
            || pool
                .live
                .compare_exchange(live, live + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("nuza-fs".into())
            .spawn(move || work(pool));
        if spawned.is_err() {
            pool.live.fetch_sub(1, Ordering::SeqCst);
            return;
        }
    }
}

fn work(pool: &'static Pool) {
    loop {
        pool.idle.fetch_add(1, Ordering::SeqCst);
        let task = {
            let mut queues = pool.queues.lock().unwrap_or_else(|p| p.into_inner());
            loop {
                if let Some(task) = queues
                    .urgent
                    .pop_front()
                    .or_else(|| queues.background.pop_front())
                {
                    break task;
                }
                queues = pool.queued.wait(queues).unwrap_or_else(|p| p.into_inner());
            }
        };
        pool.idle.fetch_sub(1, Ordering::SeqCst);

        if !task.abandoned.load(Ordering::SeqCst) {
            task.started.fetch_add(1, Ordering::SeqCst);
            (task.run)();
        }

        // Back above the usual size means this thread was a replacement for one
        // that was stuck, and the stuck one has since come back: one of the two
        // can go.
        let live = pool.live.load(Ordering::SeqCst);
        if live > WORKERS
            && pool
                .live
                .compare_exchange(live, live - 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            return;
        }
    }
}

thread_local! {
    /// Set while this thread is doing work nobody is waiting on.
    static BACKGROUND: Cell<bool> = const { Cell::new(false) };
}

/// Runs `work` with whatever it puts on the pool in the background lane:
/// served only when nothing in the other lane is waiting.
pub(crate) fn in_background<T>(work: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            BACKGROUND.with(|flag| flag.set(self.0));
        }
    }
    let _restore = Restore(BACKGROUND.with(|flag| flag.replace(true)));
    work()
}

/// Runs every job on the pool and waits for them all - but only until `within`
/// has passed since this was called. A job's answer is `None` when it had not
/// finished by then.
///
/// The jobs are independent, which is the point: one that hangs does not keep
/// the others from being answered.
pub(crate) fn run_all<T: Send + 'static>(
    jobs: Vec<Box<dyn FnOnce() -> T + Send>>,
    within: Duration,
) -> Vec<Option<T>> {
    let total = jobs.len();
    let mut answers: Vec<Option<T>> = (0..total).map(|_| None).collect();
    if total == 0 {
        return answers;
    }

    let pool = pool();
    let deadline = Instant::now() + within;
    let abandoned = Arc::new(AtomicBool::new(false));
    let started = Arc::new(AtomicUsize::new(0));
    let (reply, replies) = mpsc::channel();

    {
        let background = BACKGROUND.with(Cell::get);
        let mut queues = pool.queues.lock().unwrap_or_else(|p| p.into_inner());
        let lane = if background {
            &mut queues.background
        } else {
            &mut queues.urgent
        };
        for (index, job) in jobs.into_iter().enumerate() {
            let reply = reply.clone();
            lane.push_back(Task {
                run: Box::new(move || {
                    let _ = reply.send((index, job()));
                }),
                abandoned: abandoned.clone(),
                started: started.clone(),
            });
        }
    }
    pool.queued.notify_all();
    drop(reply);

    // Every thread is busy, which may be with calls that will never return:
    // wait on one of our own rather than behind them.
    if pool.idle.load(Ordering::SeqCst) == 0 {
        grow(pool, 1);
    }

    let mut received = 0;
    while received < total {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match replies.recv_timeout(remaining) {
            Ok((index, answer)) => {
                answers[index] = Some(answer);
                received += 1;
            }
            Err(_) => break,
        }
    }

    if received < total {
        abandoned.store(true, Ordering::SeqCst);
        // What was started and has not come back is holding a thread; keep the
        // pool at strength. What was never started is dropped, not stuck.
        let stuck = started.load(Ordering::SeqCst).saturating_sub(received);
        grow(pool, stuck);
    }
    answers
}

/// Runs one job, giving up on it after `within`.
pub(crate) fn run_one<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
    within: Duration,
) -> Option<T> {
    run_all(vec![Box::new(job)], within).pop().flatten()
}
