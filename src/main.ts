import * as core from '@actions/core'
import {context} from '@actions/github'
import {RestEndpointMethodTypes} from "@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types"
import fs from 'fs'
import isWindows from 'is-windows'
import path from 'path'
import picomatch from 'picomatch'
import rimraf from 'rimraf'
import simpleGit, {GitError, SimpleGit} from 'simple-git'
import {DefaultLogFields} from 'simple-git/src/lib/tasks/log'
import {URL} from 'url'
import {isConventionalCommit} from './internal/conventional-commits'
import {newOctokitInstance} from './internal/octokit'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', {required: true})
core.setSecret(githubToken)

const conventionalCommits = core.getInput('conventionalCommits', {required: true}).toLowerCase() === 'true'
const lfs = core.getInput('lfs', {required: true}).toLowerCase() === 'true'
const syncBranchName = getSyncBranchName()

const octokit = newOctokitInstance(githubToken)

const pullRequestLabel = 'sync-with-template'
const emailSuffix = '+sync-with-template@users.noreply.github.com'
const conflictsResolutionEmailSuffix = '+sync-with-template-conflicts-resolution@users.noreply.github.com'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const repo = await getCurrentRepo()
        if (repo.archived) {
            core.info(`Skipping template synchronization, as current repository is archived`)
            return
        }
        if (repo.fork) {
            core.info(`Skipping template synchronization, as current repository is a fork`)
            return
        }

        const templateRepo = await getTemplateRepo(core.getInput('templateRepository'), repo)
        if (templateRepo == null) {
            core.warning("Template repository name can't be retrieved: the current repository isn't created from a"
                + " template and 'templateRepository' input isn't set")
            return
        }
        core.info(`Using ${templateRepo.full_name} as a template repository`)

        const ignorePathMatcher: GlobMatcher | undefined = (function () {
            const patterns = core.getInput('ignorePaths').split('\n')
                .map(line => line.replace(/#.*/, '').trim())
                .filter(line => line.length > 0)
            if (patterns.length === 0) {
                return undefined
            }

            core.info(`Ignored files:\n  ${patterns.join('\n  ')}`)
            return picomatch(patterns, {windows: isWindows()})
        })()


        const workspacePath = require('tmp').dirSync().name
        core.saveState('workspacePath', workspacePath)

        if (process.env.ACTIONS_STEP_DEBUG?.toLowerCase() === 'true') {
            require('debug').enable('simple-git')
            process.env.DEBUG = [
                process.env.DEBUG || '',
                'simple-git',
                'simple-git:*'
            ].filter(it => it.length).join(',')
        }
        const git = simpleGit(workspacePath)

        const unstageIgnoredFiles: () => Promise<string[]> = async () => {
            const unstagedFiles: string[] = []
            if (ignorePathMatcher) {
                const status = await git.status()
                for (const filePath of status.staged) {
                    if (ignorePathMatcher(filePath)) {
                        core.info(`Ignored file: unstaging: ${filePath}`)
                        await git.raw('reset', '-q', 'HEAD', '--', filePath)
                        if (status.created.includes(filePath)) {
                            core.info(`Ignored file: removing created: ${filePath}`)
                            const absoluteFilePath = path.resolve(workspacePath, filePath)
                            fs.unlinkSync(absoluteFilePath)
                        } else {
                            core.info(`Ignored file: reverting modified/deleted: ${filePath}`)
                            await git.raw('checkout', 'HEAD', '--', filePath)
                        }
                        unstagedFiles.push(filePath)
                    }
                }
                await git.status()
            }
            return unstagedFiles
        }

        await core.group("Initializing the repository", async () => {
            await git.init()
            await git.addConfig('user.useConfigOnly', 'true')
            if (repo.owner != null) {
                await git.addConfig('user.name', repo.owner.login)
                await git.addConfig('user.email', `${repo.owner.id}+${repo.owner.login}${emailSuffix}`)
            } else {
                await git.addConfig('user.name', context.repo.owner)
                await git.addConfig('user.email', `${context.repo.owner}${emailSuffix}`)
            }
            await git.addConfig('diff.algorithm', 'patience')
            //await git.addConfig('core.pager', 'cat')
            await git.addConfig('gc.auto', '0')
            await git.addConfig('fetch.recurseSubmodules', 'no')

            core.info("Setting up credentials")
            const basicCredentials = Buffer.from(`x-access-token:${githubToken}`, 'utf8').toString('base64')
            core.setSecret(basicCredentials)
            for (const origin of [new URL(repo.svn_url).origin, new URL(templateRepo.svn_url).origin]) {
                await git.addConfig(`http.${origin}/.extraheader`, `Authorization: basic ${basicCredentials}`)
            }

            core.info(`Adding 'origin' remote: ${repo.svn_url}`)
            await git.addRemote('origin', repo.svn_url)
            await git.fetch('origin', repo.default_branch)

            core.info(`Adding 'template' remote: ${templateRepo.svn_url}`)
            await git.addRemote('template', templateRepo.svn_url)
            await git.fetch('template', templateRepo.default_branch)

            if (lfs) {
                core.info("Installing LFS")
                await git.raw('lfs', 'install', '--local')
            }
        })


        const originBranches = await gitRemoteBranches(git, 'origin')
        const doesOriginHasSyncBranch = originBranches.indexOf(`refs/heads/${syncBranchName}`) >= 0


        const lastCommitLogItem: DefaultLogFields | null = await core.group("Fetching sync branch", async () => {
            if (doesOriginHasSyncBranch) {
                await git.fetch('origin', syncBranchName)
                await git.checkout(syncBranchName)
                return null
            }

            const mergedPullRequests = (
                await octokit.paginate(octokit.pulls.list, {
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    state: 'closed',
                    head: `${context.repo.owner}:${syncBranchName}`
                })
            )
                .filter(pr => pr.head.ref === syncBranchName)
                .filter(pr => pr.head.sha !== pr.base.sha)
                .filter(pr => pr.merged_at != null)
            const sortedPullRequests = [...mergedPullRequests].sort((pr1, pr2) => {
                const mergedAt1 = new Date(pr1.merged_at!).getTime()
                const mergedAt2 = new Date(pr2.merged_at!).getTime()
                if (mergedAt1 < mergedAt2) {
                    return 1
                } else if (mergedAt1 > mergedAt2) {
                    return -1
                } else {
                    return pr2.number - pr1.number
                }
            })
            if (sortedPullRequests.length > 0) {
                const pullRequest = sortedPullRequests[0]

                core.info(`Fetching last commit of pull request #${pullRequest.number}: ${repo.html_url}/commit/${pullRequest.head.sha}`)
                const pullRequestBranchName = `refs/pull/${pullRequest.number}/head`
                await git.fetch('origin', pullRequestBranchName)

                //await git.checkoutBranch(syncBranchName, pullRequest.merge_commit_sha!)
                await git.checkoutBranch(syncBranchName, pullRequest.head.sha)

                const log = await git.log([pullRequest.head.sha])
                for (const logItem of log.all) {
                    if (logItem.author_email.endsWith(emailSuffix)) {
                        return logItem
                    }
                }
                return null
            }

            core.info(`Creating '${syncBranchName}' branch from the first commit of default branch '${repo.default_branch}'`)
            const defaultBranchLog = await git.log(['--reverse', `remotes/origin/${repo.default_branch}`])
            await git.checkoutBranch(syncBranchName, defaultBranchLog.latest!.hash)
            return null
        })


        const lastSynchronizedCommitDate: Date = await core.group(
            "Retrieving last synchronized commit date",
            async () => {
                if (lastCommitLogItem != null) {
                    core.info(`Last synchronized commit is: ${repo.html_url}/commit/${lastCommitLogItem.hash} (${lastCommitLogItem.date}): ${lastCommitLogItem.message}`)
                    return new Date(lastCommitLogItem.date)
                }

                const syncBranchLog = await git.log()
                for (const logItem of syncBranchLog.all) {
                    if (logItem.author_email.endsWith(emailSuffix)) {
                        core.info(`Last synchronized commit is: ${repo.html_url}/commit/${logItem.hash} (${logItem.date}): ${logItem.message}`)
                        return new Date(logItem.date)
                    }
                }

                const latestLogItem = syncBranchLog.latest!
                core.info(`Last synchronized commit is: ${repo.html_url}/commit/${latestLogItem.hash} (${latestLogItem.date}): ${latestLogItem.message}`)
                return new Date(latestLogItem.date)
            }
        )
        const lastSynchronizedCommitTimestamp = lastSynchronizedCommitDate.getTime() / 1000


        const cherryPickedCommitCounts: number = await core.group("Cherry-picking template commits", async () => {
            const templateBranchName = templateRepo.default_branch
            await git.fetch('template', templateBranchName)
            const templateBranchLog = await git.log([
                '--reverse',
                `--since=${lastSynchronizedCommitTimestamp + 1}`,
                `remotes/template/${templateBranchName}`
            ])
            let count = 0
            for (const logItem of templateBranchLog.all) {
                const logDate = new Date(logItem.date)
                if (logDate.getTime() <= lastSynchronizedCommitDate.getTime()) {
                    continue
                }

                ++count
                core.info(`Cherry-picking ${templateRepo.html_url}/commit/${logItem.hash} (${logItem.date}): ${logItem.message}`)

                try {
                    await git.raw(
                        'cherry-pick',
                        '--no-commit',
                        '-r',
                        '--allow-empty',
                        '--allow-empty-message',
                        '--strategy=recursive',
                        '-Xours',
                        logItem.hash
                    )
                } catch (reason) {
                    if (reason instanceof GitError
                        && reason.message.includes(`could not apply ${logItem.hash.substring(0, 6)}`)
                    ) {
                        const unstagedFiles = await unstageIgnoredFiles()
                        const status = await git.status()
                        const unresolvedConflictedFiles: string[] = []
                        for (const conflictedPath of status.conflicted) {
                            if (unstagedFiles.includes(conflictedPath)) {
                                continue
                            }
                            const fileInfo = status.files.find(file => file.path === conflictedPath)
                            if (fileInfo !== undefined && fileInfo.working_dir === 'U') {
                                if (fileInfo.index === 'A') {
                                    core.info(`Resolving conflict: adding file: ${conflictedPath}`)
                                    await git.add(conflictedPath)
                                    continue
                                } else if (fileInfo.index === 'D') {
                                    core.info(`Resolving conflict: removing file: ${conflictedPath}`)
                                    await git.raw('rm', '-f', conflictedPath)
                                    continue
                                }
                            }
                            core.error(`Unresolved conflict: ${conflictedPath}`)
                            unresolvedConflictedFiles.push(conflictedPath)
                        }
                        if (unresolvedConflictedFiles.length > 0) {
                            throw reason
                        }
                    } else {
                        throw reason
                    }
                }

                await unstageIgnoredFiles()

                let message = logItem.message
                    .replace(/( \(#\d+\))+$/, '')
                    .trim()
                if (message.length === 0) {
                    message = `Cherry-pick ${logItem.hash}`
                }
                if (conventionalCommits) {
                    if (isConventionalCommit(message)) {
                        // do nothing
                    } else {
                        message = `chore(template): ${message}`
                    }
                }
                await git
                    .env('GIT_AUTHOR_DATE', logItem.date)
                    .env('GIT_COMMITTER_DATE', logItem.date)
                    .commit(message, {
                        '--allow-empty': null,
                    })
            }
            return count
        })


        let createdPullRequestNumber: number | undefined = undefined
        if (cherryPickedCommitCounts === 0) {
            core.info("No commits were cherry-picked from template repository")

        } else {
            core.info(`Pushing ${cherryPickedCommitCounts} commits`)
            await git.raw('push', 'origin', syncBranchName)

            const openedPullRequests = (
                await octokit.pulls.list({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    state: 'open',
                    head: `${context.repo.owner}:${syncBranchName}`,
                    sort: 'created',
                    direction: 'desc',
                })
            ).data.filter(pr => pr.head.ref === syncBranchName)
            if (openedPullRequests.length > 0) {
                const openedPullRequest = openedPullRequests[0]
                core.info(`Skip creating pull request for '${syncBranchName}' branch`
                    + `, as there is an opened one: ${openedPullRequest.html_url}`
                )
                createdPullRequestNumber = openedPullRequest.number

            } else {
                let pullRequestTitle = `Merge template repository changes: ${templateRepo.full_name}`
                if (conventionalCommits) {
                    pullRequestTitle = `chore(template): ${pullRequestTitle}`
                }

                const pullRequest = (
                    await octokit.pulls.create({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        head: syncBranchName,
                        base: repo.default_branch,
                        title: pullRequestTitle,
                        body: "Template repository changes."
                            + "\n\nIf you close this PR, it will be recreated automatically.",
                        maintainer_can_modify: true,
                    })
                ).data
                await octokit.issues.addLabels({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: pullRequest.number,
                    labels: [pullRequestLabel]
                })
                core.info(`Pull request for '${syncBranchName}' branch has been created: ${pullRequest.html_url}`)
                createdPullRequestNumber = pullRequest.number
            }
        }


        if (ignorePathMatcher) {
            core.debug('Resolving merge conflicts for ignored files')
            let conflictPullRequest: PullRequest | undefined = undefined
            if (createdPullRequestNumber) {
                const pullRequest = await octokit.pulls.get({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    pull_number: createdPullRequestNumber
                }).then(it => it.data)
                if (pullRequest.mergeable_state === 'dirty') {
                    conflictPullRequest = pullRequest
                }
            } else {
                const openedPullRequests = (
                    await octokit.pulls.list({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        state: 'open',
                        head: `${context.repo.owner}:${syncBranchName}`,
                        sort: 'created',
                        direction: 'desc',
                    })
                ).data.filter(pr => pr.head.ref === syncBranchName)
                for (const pullRequestSimple of openedPullRequests) {
                    const pullRequest = await octokit.pulls.get({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        pull_number: pullRequestSimple.number
                    }).then(it => it.data)
                    if (pullRequest.mergeable_state === 'dirty') {
                        conflictPullRequest = pullRequest
                        break
                    }
                }
            }

            if (conflictPullRequest) {
                await core.group(
                    `Trying to resolve merge conflicts for ignored files of ${conflictPullRequest.html_url}`,
                    async () => {
                        await git.fetch('origin', repo.default_branch)
                        await git.fetch('origin', syncBranchName)
                        await git.raw('checkout', '-f', '-B', syncBranchName, `remotes/origin/${syncBranchName}`)
                        try {
                            await git.raw('merge', '--no-commit', '--no-ff', `remotes/origin/${repo.default_branch}`)
                        } catch (reason) {
                            if (reason instanceof GitError
                                && reason.message.includes('Automatic merge failed; fix conflicts')
                            ) {
                                // Merge conflicts will be resolved below
                            } else {
                                throw reason
                            }
                        }

                        const status = await git.status()
                        core.info(`status: ${JSON.stringify(status, null, 2)}`)
                        const conflictingNotIgnoredFiles = status.conflicted.filter(it => !ignorePathMatcher(it))
                        if (conflictingNotIgnoredFiles.length) {
                            core.error(`Automatic merge-conflict resolution for ignored files failed`
                                + `, as there are some conflict in included`
                                + ` files:\n  ${conflictingNotIgnoredFiles.join('\n  ')}`
                            )
                            await git.raw('merge', '--abort')

                        } else {
                            for (const conflictedPath of status.conflicted) {
                                const fileInfo = status.files.find(file => file.path === conflictedPath)
                                if (fileInfo && fileInfo.working_dir === 'D') {
                                    core.info(`Resolving conflict: removing file: ${conflictedPath}`)
                                    await git.raw('rm', '-f', conflictedPath)
                                } else {
                                    core.info(`Resolving conflict: using file from`
                                        + ` '${repo.default_branch}' branch: ${conflictedPath}`)
                                    await git.raw(
                                        'checkout',
                                        '-f',
                                        `remotes/origin/${syncBranchName}`,
                                        '--',
                                        conflictedPath
                                    )
                                }
                            }

                            core.info('Committing changes')
                            if (repo.owner != null) {
                                await git.addConfig(
                                    'user.email',
                                    `${repo.owner.id}+${repo.owner.login}${conflictsResolutionEmailSuffix}`
                                )
                            } else {
                                await git.addConfig(
                                    'user.email',
                                    `${context.repo.owner}${conflictsResolutionEmailSuffix}`
                                )
                            }
                            await git.raw('commit', '--no-edit')

                            core.info('Pushing merge-commit')
                            await git.raw('push', 'origin', syncBranchName)
                        }
                    }
                )
            }
        }

    } catch (error) {
        core.setFailed(error)
    }
}

async function cleanup(): Promise<void> {
    try {
        const workspacePath = core.getState('workspacePath')
        if (!workspacePath) {
            throw new Error('workspacePath must be set')
        }

        core.debug(`Removing workspace: ${workspacePath}`)
        rimraf.sync(workspacePath)

    } catch (error) {
        core.warning(error)
    }
}

if (!core.getState('isExecuted')) {
    core.saveState('isExecuted', 'true')
    //noinspection JSIgnoredPromiseFromCall
    run()
} else {
    //noinspection JSIgnoredPromiseFromCall
    cleanup()
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

type GlobMatcher = (filePath: string) => boolean

function getSyncBranchName(): string {
    const name = core.getInput('syncBranchName', {required: true})
    if (!conventionalCommits || name.toLowerCase().startsWith('chore/')) {
        return name
    } else {
        return `chore/${name}`
    }
}

async function gitRemoteBranches(git: SimpleGit, remoteName: string): Promise<string[]> {
    return git.listRemote(['--exit-code', '--heads', remoteName]).then(content => {
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => line.split('\t')[1])
            .map(line => line.trim())
            .filter(line => line.length > 0)
    })
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

type Repo = RestEndpointMethodTypes['repos']['get']['response']['data']
type PullRequest = RestEndpointMethodTypes['pulls']['get']['response']['data']

async function getCurrentRepo(): Promise<Repo> {
    return getRepo(context.repo.owner, context.repo.repo)
}

async function getTemplateRepo(templateRepoName: string, currentRepo: Repo): Promise<Repo | null> {
    if (templateRepoName === currentRepo.template_repository?.full_name) {
        const templateRepo = currentRepo.template_repository as any as Repo
        return Promise.resolve(templateRepo)

    } else if (templateRepoName === '') {
        if (currentRepo.template_repository != null) {
            const templateRepo = currentRepo.template_repository as any as Repo
            return Promise.resolve(templateRepo)
        }

    } else {
        const [owner, repo] = templateRepoName.split('/')
        return getRepo(owner, repo)
    }

    return Promise.resolve(null)
}

async function getRepo(owner: string, repo: string): Promise<Repo> {
    return octokit.repos.get({owner, repo}).then(it => it.data)
}
