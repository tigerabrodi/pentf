const assert = require('assert').strict;

const output = require('./output');
const {wait} = require('./utils');
const external_locking = require('./external_locking');

/**
 * @typedef {{resource: string, expireIn: number, client?: string}} Lock
 */

/**
 * @param {import('./config').Config} config
 * @param {import('./internal').Task} task
 * @private
 */
function annotateTaskResources(config, task) {
    if (config.no_locking) {
        return;
    }

    for (const r of task.resources) {
        assert(/^[-A-Za-z_0-9]+$/.test(r), `Invalid resource name in task ${task.id}: ${JSON.stringify(r)}`);
    }
}

/**
 * @param {import('./config').Config} config
 * @param {import('./internal').RunnerState} state
 * @private
 */
async function init(config, state) {
    assert(config);
    assert(state);
    state.locks = new Set();
    external_locking.init(config, state);
}

/**
 * @param {import('./config').Config} config
 * @param {import('./internal').RunnerState} state
 * @private
 */
async function shutdown(config, state) {
    external_locking.shutdown(config, state);
    state.locks.length = 0;
    assert.equal(
        state.locks.size, 0,
        `Still got some locks on shutdown: ${Array.from(state.locks).sort().join(',')}`);
}

/**
 * Aquire locks on resources
 * @param {import('./config').Config} config
 * @param {import('./internal').RunnerState} state
 * @param {import('./internal').Task} task
 */
async function acquire(config, state, task) {
    if (config.no_locking) return true;

    assert(task);
    if (! task.resources.length) {
        return true;
    }

    const {locks} = state;
    assert(locks);
    if (task.resources.some(r => locks.has(r))) {
        if (config.locking_verbose || config.log_file) {
            const failed = task.resources.filter(r => locks.has(r));

            output.logVerbose(config, `[locking] ${task.id}: Failed to acquire ${failed.join(',')}`);
        }
        return false;
    }

    if (! config.no_external_locking) {
        try {
            const acquireRes = await external_locking.externalAcquire(config, task.resources, 40000);
            if (acquireRes !== true) {
                if (config.locking_verbose || config.log_file) {
                    output.logVerbose(config,
                        `[exlocking] ${task.id}: Failed to acquire ${acquireRes.resource}`  +
                        `, held by ${acquireRes.client}, expires in ${acquireRes.expireIn} ms`);
                }
                return false;
            }
        } catch(e) {
            // Something is wrong with the locking server
            output.color(config, 'red', `[exlocking] Failed to acquire locks for ${task.id}. Is the lockserver up and running?\n\n${e.stack}`);
            return false;
        }
    }

    for (const r of task.resources) {
        locks.add(r);
    }
    if (config.locking_verbose || config.log_file) {
        output.logVerbose(config, `[locking] ${task.id}: Acquired ${task.resources.join(',')}`);
    }
    return true;
}

/**
 * @param {import('./config').Config} config
 * @param {import('./internal').RunnerState} state
 * @param {import('./internal').Task} task
 */
async function acquireEventually(config, state, task) {
    if (config.no_locking) return true;
    if (config.locking_verbose || config.log_file) {
        output.logVerbose(config, `[locking] ${task.id}: Trying to eventually acquire ${task.resources.join(',')}`);
    }
    let waitTime = 50;
    while (! await acquire(config, state, task)) {
        await wait(waitTime);
        waitTime = Math.min(10000, waitTime * 2);
    }
    return true;
}

/**
 * Release locks on resources
 * @param {import('./config').Config} config
 * @param {import('./internal').RunnerState} state
 * @param {import('./internal').Task} task
 */
async function release(config, state, task) {
    if (config.no_locking) return true;
    if (! task.resources.length) {
        return;
    }

    if (! config.no_external_locking) {
        try {
            const response = await external_locking.externalRelease(config, task.resources);
            if (response !== true) {
                if (config.locking_verbose || config.log_file) {
                    output.logVerbose(config,
                        `[exlocking] ${task.id}: Failed to release ${response.resource}` +
                        `, held by ${response.client} expires in ${response.expireIn} ms`);
                }
            }
        } catch(e) {
            output.log(config, `[exlocking] Failed to release for ${task.id}: ${e.stack}`);
        }
    }

    const {locks} = state;
    for (const r of task.resources) {
        assert(locks.has(r), `Trying to release ${r} for ${task.id}, but not in current locks ${Array.from(locks).sort().join(',')}`);
        locks.delete(r);
    }
    if (config.locking_verbose || config.log_file) {
        output.logVerbose(config, `[locking] ${task.id}: Released ${task.resources.join(',')}`);
    }
}

/**
 * @param {import('./config').Config} config
 * @param {import('./internal').Task[]} tasks
 * @private
 */
function listConflicts(config, tasks) {
    const tasksByResource = new Map();
    for (const t of tasks) {
        for (const r of t.resources) {
            let tasks = tasksByResource.get(r);
            if (!tasks) {
                tasks = [];
                tasksByResource.set(r, tasks);
            }
            tasks.push(t);
        }
    }

    let anyConflicts = false;
    for (const [resource, tasks] of tasksByResource) {
        if (tasks.length === 1) continue;

        anyConflicts = true;
        output.log(config, `${resource}: ${tasks.map(t => t.id).join(' ')}`);
    }
    if (! anyConflicts) {
        output.log(config, 'No resource conflicts found');
    }
}

module.exports = {
    acquire,
    acquireEventually,
    annotateTaskResources,
    init,
    listConflicts,
    release,
    shutdown,
};
