import * as core from '@actions/core'
import {newOctokitInstance} from './internal/octokit'
import {context} from '@actions/github'
import {RestEndpointMethodTypes} from "@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types"
import simpleGit, {SimpleGit} from 'simple-git'
import {isConventionalCommit} from './internal/conventional-commits'
import {DefaultLogFields} from 'simple-git/src/lib/tasks/log'

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
        require('debug').enable('simple-git')
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
            await git.fetch('origin', repo.default_branch)

            core.info(`Adding 'template' remote: ${templateRepo.svn_url}`)
            await git.addRemote('template', templateRepo.svn_url)
            await git.fetch('template', templateRepo.default_branch)

            core.info("Installing LFS")
            await git.raw(['lfs', 'install', '--local'])
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
                    core.info(`Last synchronized commit is: ${lastCommitLogItem.hash}: ${lastCommitLogItem.message}`)
                    return new Date(lastCommitLogItem.date)
                }

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


        const cherryPickedCommits: CherryPickedCommit[] = []
        await core.group("Cherry-picking template commits", async () => {
            const templateBranchName = templateRepo.default_branch
            await git.fetch('template', templateBranchName)
            const templateBranchLog = await git.log([
                '--reverse',
                `--since=${lastSynchronizedCommitTimestamp + 1}`,
                `remotes/template/${templateBranchName}`
            ])
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
                await git
                    .env('GIT_AUTHOR_DATE', logItem.date)
                    .env('GIT_COMMITTER_DATE', logItem.date)
                    .commit(message, {
                        '--allow-empty': null,
                    })

                cherryPickedCommits.push({
                    templateCommit: logItem,
                    message,
                    hash: await git.raw(['rev-parse', 'HEAD']).then(text => text.trim())
                })
            }
        })
        if (cherryPickedCommits.length === 0) {
            core.info("No commits were cherry-picked from template repository")
        }


        let isDiffEmpty = false
        const mergeBase = await git.raw([
            'merge-base',
            `remotes/origin/${repo.default_branch}`,
            syncBranchName
        ]).then(text => text.trim())
        core.info(`mergeBase=${mergeBase}`)
        if (mergeBase !== '') {
            const diff = await git.raw([
                'merge-tree',
                mergeBase,
                `remotes/origin/${repo.default_branch}`,
                syncBranchName
            ]).then(text => text.trim())
            core.info(`diff=${diff}`)
            isDiffEmpty = diff === ''
        }
        core.info(`isDiffEmpty=${isDiffEmpty}`)


        if (cherryPickedCommits.length > 0) {
            if (!isDiffEmpty || doesOriginHasSyncBranch) {
                core.info(`Pushing ${cherryPickedCommits.length} commits`)
                await git.raw(['push', 'origin', syncBranchName])
            }
        }


        if (isDiffEmpty) {
            await core.group(`Diff is empty, clearing '${syncBranchName}' branch`, async () => {
                const pullRequests = (
                    await octokit.paginate(octokit.pulls.list, {
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        state: 'open',
                        head: `${context.repo.owner}:${syncBranchName}`
                    })
                ).filter(pr => pr.head.ref === syncBranchName)
                for (const pullRequest of pullRequests) {
                    core.info(`Closing empty pull request: ${pullRequest.html_url}`)
                    await octokit.issues.createComment({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        issue_number: pullRequest.number,
                        body: "Closing empty pull request",
                    })
                    const autoclosedSuffix = ' - autoclosed'
                    let newTitle = pullRequest.title
                    if (!newTitle.endsWith(autoclosedSuffix)) {
                        newTitle = `${newTitle}${autoclosedSuffix}`
                    }
                    await octokit.pulls.update({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        pull_number: pullRequest.number,
                        title: newTitle,
                    })
                    await octokit.issues.update({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        issue_number: pullRequest.number,
                        state: 'closed',
                    })
                }

                if (doesOriginHasSyncBranch) {
                    core.info(`Removing '${syncBranchName}' branch from origin remote`)
                    await git.raw(['push', '--delete', 'origin', syncBranchName])
                }
            })

            return
        }


        let pullRequestTitle = "Merge template repository changes"
        if (conventionalCommits) {
            pullRequestTitle = `chore(template): ${pullRequestTitle}`
        }

        const diffCommits: DefaultLogFields[] = []
        if (mergeBase !== '') {
            const log = await git.log({from: mergeBase, to: syncBranchName})
            for (const logItem of log.all) {
                if (logItem.author_email.endsWith(emailSuffix)) {
                    const diff = await git.raw([
                        'merge-tree',
                        mergeBase,
                        `remotes/origin/${repo.default_branch}`,
                        logItem.hash
                    ]).then(text => text.trim())
                    if (diff !== '') {
                        diffCommits.push(logItem)
                        core.info(`diffCommitMessages[]=${logItem.message}`)
                    }
                }
            }
        }
        if (diffCommits.length === 1) {
            pullRequestTitle = diffCommits.values().next().value
        }

        let pullRequestBody = "Template repository changes."
            + "\n\nIf you close this PR, it will be recreated automatically."
        if (diffCommits.length > 0) {
            pullRequestBody += "\n\nCommits to merge:"
            for (const diffCommit of diffCommits) {
                const cherryPickedCommit = cherryPickedCommits.find(commit => commit.hash === diffCommit.hash)
                if (cherryPickedCommit != null) {
                    pullRequestBody += `\n* [${diffCommit.message}](${templateRepo.html_url}/commit/${cherryPickedCommit.templateCommit.hash})`
                } else {
                    pullRequestBody += `\n* ${diffCommit.message}`
                }
            }
        }

        const hasAtLeastOneOpenedPullRequest = await core.group("Process opened pull requests", async () => {
            const pullRequests = (
                await octokit.paginate(octokit.pulls.list, {
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    state: 'open',
                    head: `${context.repo.owner}:${syncBranchName}`
                })
            ).filter(pr => pr.head.ref === syncBranchName)

            if (pullRequests.length === 0) {
                core.info(`No opened pull requests found for '${syncBranchName}' branch`)
                return false
            }

            for (const pullRequest of pullRequests) {
                await core.group(`Processing opened pull request: ${pullRequest.html_url}`, async () => {
                    if (pullRequest.title !== pullRequestTitle) {
                        const eventsIterator = octokit.paginate.iterator(octokit.issues.listEvents, {
                            owner: context.repo.owner,
                            repo: context.repo.repo,
                            issue_number: pullRequest.number,
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

                        if (!wasRenamed) {
                            core.info(`Renaming from '${pullRequest.title}' to '${pullRequestTitle}'`)
                            await octokit.pulls.update({
                                owner: context.repo.owner,
                                repo: context.repo.repo,
                                pull_number: pullRequest.number,
                                title: pullRequestTitle,
                            })
                        }
                    }

                    if (pullRequest.body !== pullRequestBody) {
                        core.info("Changing pull request body")
                        await octokit.pulls.update({
                            owner: context.repo.owner,
                            repo: context.repo.repo,
                            pull_number: pullRequest.number,
                            body: pullRequestBody,
                        })
                    }
                })
            }

            return true
        })


        if (cherryPickedCommits.length > 0 && !hasAtLeastOneOpenedPullRequest) {
            await core.group("Creating pull request", async () => {
                const pullRequest = (
                    await octokit.pulls.create({
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        head: syncBranchName,
                        base: repo.default_branch,
                        title: pullRequestTitle,
                        body: pullRequestBody,
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
        }


    } catch (error) {
        core.setFailed(error)
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

type CherryPickedCommit = {
    templateCommit: DefaultLogFields,
    message: string,
    hash: string,
}

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
