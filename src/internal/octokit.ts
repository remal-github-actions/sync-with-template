import * as core from '@actions/core'
import { getOctokitOptions } from '@actions/github/lib/utils.js'
import { Octokit as OctokitBaseFactory } from '@octokit/core'
import { paginateRest } from '@octokit/plugin-paginate-rest'
import { requestLog } from '@octokit/plugin-request-log'
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import * as logging from 'console-log-level'

const OctokitFactory = OctokitBaseFactory.plugin(
    restEndpointMethods,
    paginateRest,
    retry,
    throttling,
    requestLog,
)

export function newOctokitInstance(token: string) {
    const baseOptions = getOctokitOptions(token)

    const previewsOptions = {
        previews: [
            'baptiste',
            'mercy',
        ],
    }

    const retryOptions = {
        retry: {
            doNotRetry: ['429'],
        },
    }

    const throttleOptions = {
        throttle: {
            onRateLimit: (retryAfter, options) => {
                const retryCount = options.request.retryCount
                const retryLogInfo = retryCount === 0 ? '' : ` (retry #${retryCount})`
                if (retryCount < 3) {
                    core.warning(`Request quota exhausted for request ${options.method} ${options.url}${retryLogInfo}.`
                        + ` Retrying after ${retryAfter} seconds.`,
                    )
                    return true
                }

                core.error(`Request quota exhausted for request ${options.method} ${options.url}${retryLogInfo}.`
                    + ` Not retrying, as too many retries were made.`,
                )
                return false
            },
            onSecondaryRateLimit: (_, options) => {
                core.error(`Abuse detected for request ${options.method} ${options.url}`)
                return false
            },
        },
    }

    const logOptions: { log?: logging.Logger } = {}
    const traceLogging = logging.default({ level: 'trace' })
    if (core.isDebug()) {
        logOptions.log = traceLogging
    }

    const options = {
        ...baseOptions,
        ...previewsOptions,
        ...retryOptions,
        ...throttleOptions,
        ...logOptions,
    }

    const octokit = new OctokitFactory(options)

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
