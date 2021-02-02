import * as core from '@actions/core'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        core.info("action logic")

    } catch (error) {
        core.setFailed(error)
    }
}

//noinspection JSIgnoredPromiseFromCall
run()
