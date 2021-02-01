import * as core from '@actions/core'
import {newOctokitInstance} from './internal/octokit'
import {context} from '@actions/github'
import {RestEndpointMethodTypes} from "@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types"
import simpleGit, {GitError} from 'simple-git'
import './internal/simple-git-extensions'
import {isConventionalCommit} from './internal/conventional-commits'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const pushToken = core.getInput('githubToken', {required: true})
core.setSecret(pushToken)

const conventionalCommits = core.getInput('conventionalCommits', {required: true}).toLowerCase() === 'true'
const syncBranchName = getSyncBranchName()

const octokit = newOctokitInstance(pushToken)

const pullRequestLabel = 'sync-with-template'
const emailSuffix = '+sync-with-template@users.noreply.github.com'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const repo = await getCurrentRepo()
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

        const workspacePath = require('tmp').dirSync().name
        //require('debug').enable('simple-git')
        const git = simpleGit(workspacePath)
        await core.group("Initializing the repository", async () => {
            await git.init()
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
            const basicCredentials = Buffer.from(`x-access-token:${pushToken}`, 'utf8').toString('base64')
            core.setSecret(basicCredentials)
            for (const origin of [new URL(repo.svn_url).origin, new URL(templateRepo.svn_url).origin]) {
                await git.addConfig(`http.${origin}/.extraheader`, `Authorization: basic ${basicCredentials}`)
            }

            core.info(`Adding 'origin' remote: ${repo.svn_url}`)
            await git.addRemote('origin', repo.svn_url)
            await git.ping('origin')

            core.info(`Adding 'template' remote: ${templateRepo.svn_url}`)
            await git.addRemote('template', templateRepo.svn_url)
            await git.ping('template')

            core.info("Installing LFS")
            await git.installLfs()
        })

        await core.group("Fetching sync branch", async () => {
            let isFetchExecutedSuccessfully = true
            try {
                await git.fetch('origin', syncBranchName)
            } catch (e) {
                if (e instanceof GitError) {
                    isFetchExecutedSuccessfully = false
                } else {
                    throw e
                }
            }
            if (isFetchExecutedSuccessfully) {
                await git.checkout(syncBranchName)
                return
            }

            const defaultBranchName = repo.default_branch
            await git.fetch('origin', defaultBranchName)

            const allPullRequests = await octokit.paginate(octokit.pulls.list, {
                owner: context.repo.owner,
                repo: context.repo.repo,
                state: 'closed',
                head: `${context.repo.owner}:${syncBranchName}`
            })
            const filteredPullRequests = allPullRequests
                .filter(pr => pr.head.ref === syncBranchName)
                .filter(pr => pr.head.sha !== pr.base.sha)
            const mergedPullRequests = filteredPullRequests
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
                core.info(`Creating '${syncBranchName}' branch from merge commit of #${pullRequest.number}: ${pullRequest.merge_commit_sha}`)
                await git.checkoutBranch(syncBranchName, pullRequest.merge_commit_sha!)
                return
            }

            core.info(`Creating '${syncBranchName}' branch from the first commit of default branch '${defaultBranchName}'`)
            const defaultBranchLog = await git.log(['--reverse', `remotes/origin/${defaultBranchName}`])
            await git.checkoutBranch(syncBranchName, defaultBranchLog.latest!.hash)
        })

        const lastSynchronizedCommitDate: Date = await core.group(
            "Retrieving last synchronized commit date",
            async () => {
                const syncBranchLog = await git.log()
                for (const logItem of syncBranchLog.all) {
                    if (logItem.author_email.endsWith(emailSuffix)) {
                        core.info(`Last synchronized commit is: ${logItem.hash}: ${logItem.message}`)
                        return new Date(logItem.date)
                    }
                }

                const latestLogItem = syncBranchLog.latest!
                core.info(`Last synchronized commit is: ${latestLogItem.hash}: ${latestLogItem.message}`)
                return new Date(latestLogItem.date)
            }
        )
        const lastSynchronizedCommitTimestamp = lastSynchronizedCommitDate.getTime() / 1000

        const commitMessages: Set<string> = await core.group("Cherry-picking template commits", async () => {
            const templateBranchName = templateRepo.default_branch
            await git.fetch('template', templateBranchName)
            const templateBranchLog = await git.log([
                '--reverse',
                `--since=${lastSynchronizedCommitTimestamp + 1}`,
                `remotes/template/${templateBranchName}`
            ])
            const messages = new Set<string>()
            for (const logItem of templateBranchLog.all) {
                core.info(`Cherry-picking ${logItem.hash}: ${logItem.message}`)

                await git.raw([
                    'cherry-pick',
                    '--no-commit',
                    '-r',
                    '--allow-empty',
                    '--allow-empty-message',
                    '--strategy=recursive',
                    '-Xours',
                    logItem.hash
                ])

                let message = logItem.message
                    .replace(/ \(#\d+\)$/, '')
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
                messages.add(message)
                await git
                    .env('GIT_AUTHOR_DATE', logItem.date)
                    .env('GIT_COMMITTER_DATE', logItem.date)
                    .commit(message, {
                        '--allow-empty': null,
                    })
            }
            return messages
        })

        if (commitMessages.size > 0) {
            await core.group(`Pushing ${commitMessages.size} commits`, async () => {
                await git.raw(['push', 'origin', syncBranchName])
            })

            await core.group("Creating pull request", async () => {
                let pullRequestTitle = `Merge template repository changes: ${templateRepo.full_name}`
                if (conventionalCommits) {
                    pullRequestTitle = `chore(template): ${pullRequestTitle}`
                }

                const allPullRequests = await octokit.paginate(octokit.pulls.list, {
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    state: 'open',
                    head: `${context.repo.owner}:${syncBranchName}`
                })
                const filteredPullRequests = allPullRequests
                    .filter(pr => pr.head.ref === syncBranchName)
                if (filteredPullRequests.length > 0) {
                    for (const filteredPullRequest of filteredPullRequests) {
                        if (filteredPullRequest.title === pullRequestTitle) {
                            continue
                        }

                        const commitsIterator = octokit.paginate.iterator(octokit.pulls.listCommits, {
                            owner: context.repo.owner,
                            repo: context.repo.repo,
                            pull_number: filteredPullRequest.number,
                        })
                        let syncCommitsCount = 0
                        allCommits: for await (const commitsResponse of commitsIterator) {
                            for (const commit of commitsResponse.data) {
                                const committer = commit.commit.committer || commit.commit.author
                                const email = committer!.email || ''
                                if (email.endsWith(emailSuffix)) {
                                    ++syncCommitsCount
                                    if (syncCommitsCount >= 2) {
                                        break allCommits
                                    }
                                }
                            }
                        }

                        const eventsIterator = octokit.paginate.iterator(octokit.issues.listEvents, {
                            owner: context.repo.owner,
                            repo: context.repo.repo,
                            issue_number: filteredPullRequest.number,
                        })
                        let wasRenamed = false
                        allEvents: for await (const eventsResponse of eventsIterator) {
                            for (const event of eventsResponse.data) {
                                if (event.event === 'renamed') {
                                    wasRenamed = true
                                    break allEvents
                                }
                            }
                        }

                        if (!wasRenamed && syncCommitsCount >= 2) {
                            core.info(`Renaming pull request #${filteredPullRequest.number} from '${filteredPullRequest.title}' to '${pullRequestTitle}'`)
                            await octokit.pulls.update({
                                owner: context.repo.owner,
                                repo: context.repo.repo,
                                pull_number: filteredPullRequest.number,
                                title: pullRequestTitle,
                            })
                        }
                    }
                    core.info(`Skip creating, as there is an opened pull request for '${syncBranchName}' branch: ${filteredPullRequests[0].html_url}`)
                    return
                }

                if (commitMessages.size === 1) {
                    pullRequestTitle = commitMessages.values().next().value
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
            })

        } else {
            core.info("No commits were cherry-picked from template repository")
        }

    } catch (error) {
        core.setFailed(error)
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

function getSyncBranchName(): string {
    const name = core.getInput('syncBranchName', {required: true})
    if (!conventionalCommits || name.toLowerCase().startsWith('chore/')) {
        return name
    } else {
        return `chore/${name}`
    }
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

type Repo = RestEndpointMethodTypes['repos']['get']['response']['data']

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
