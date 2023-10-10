import * as core from '@actions/core'
import { getOctokitOptions, GitHub } from '@actions/github/lib/utils'
import { Octokit as OctokitCore } from '@octokit/core'
import { requestLog } from '@octokit/plugin-request-log'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'

const OctokitWithPlugins = GitHub
    .plugin(retry)
    .plugin(throttling)
    .plugin(requestLog)
    .defaults({
        previews: [
            'baptiste',
            'mercy',
        ],
    })

export function newOctokitInstance(token: string) {
    const baseOptions = getOctokitOptions(token)

    const throttleOptions = {
        throttle: {
            onRateLimit: (retryAfter, options) => {
                const retryCount = options.request.retryCount
                const retryLogInfo = retryCount === 0 ? '' : ` (retry #${retryCount})`
                core.debug(`Request quota exhausted for request ${options.method} ${options.url}${retryLogInfo}`)
                return retryCount <= 4
            },
            onSecondaryRateLimit: (retryAfter, options) => {
                core.error(`Abuse detected for request ${options.method} ${options.url}`)
                return false // Don't repeat
            },
        },
    }

    const retryOptions = {
        retry: {
            doNotRetry: ['429'],
        },
    }

    const logOptions: { log?: OctokitCore['log'] } = {}
    const traceLogging = require('console-log-level')({ level: 'trace' })
    if (core.isDebug()) {
        logOptions.log = traceLogging
    }

    const allOptions = {
        ...baseOptions,
        ...throttleOptions,
        ...retryOptions,
        ...logOptions,
    }

    const octokit = new OctokitWithPlugins(allOptions)

    type Rest = typeof octokit.rest
    type Paginate = { paginate: typeof octokit.paginate }
    type Client = Rest & Paginate

    const client: Client = {
        ...octokit.rest,
        paginate: octokit.paginate,
    }
    return client
}

export type Octokit = ReturnType<typeof newOctokitInstance>
