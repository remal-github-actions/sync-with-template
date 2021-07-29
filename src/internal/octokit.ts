import * as core from '@actions/core'
import {getOctokitOptions, GitHub} from '@actions/github/lib/utils'
import {Octokit as OctokitCore} from '@octokit/core'
import {PaginateInterface} from '@octokit/plugin-paginate-rest'
import {requestLog} from '@octokit/plugin-request-log'
import {RestEndpointMethods} from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/method-types'
import {retry} from '@octokit/plugin-retry'
import {throttling} from '@octokit/plugin-throttling'

const OctokitWithPlugins = GitHub
    .plugin(retry)
    .plugin(throttling)
    .plugin(requestLog)
    .defaults({
        previews: [
            'baptiste',
            'mercy',
        ]
    })


export type Octokit = RestEndpointMethods & { paginate: PaginateInterface }

export function newOctokitInstance(token: string): Octokit {
    const baseOptions = getOctokitOptions(token)

    const throttleOptions = {
        throttle: {
            onRateLimit: (retryAfter, options) => {
                const retryCount = options.request.retryCount
                const retryLogInfo = retryCount === 0 ? '' : ` (retry #${retryCount})`
                core.debug(`Request quota exhausted for request ${options.method} ${options.url}${retryLogInfo}`)

                return retryCount <= 4
            },
            onAbuseLimit: (retryAfter, options) => {
                core.warning(`Abuse detected for request ${options.method} ${options.url}`)
                return false // Don't repeat
            }
        }
    }

    const retryOptions = {
        retry: {
            doNotRetry: ['429']
        }
    }

    const logOptions: { log?: OctokitCore['log'] } = {}
    if (process.env.ACTIONS_STEP_DEBUG?.toLowerCase() === 'true') {
        logOptions.log = require('console-log-level')({level: 'trace'})
    }

    const allOptions = {
        ...baseOptions,
        ...throttleOptions,
        ...retryOptions,
        ...logOptions
    }

    const octokit = new OctokitWithPlugins(allOptions)
    return Object.assign(
        {},
        octokit.rest,
        {paginate: octokit.paginate}
    )
}
