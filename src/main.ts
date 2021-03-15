import * as core from '@actions/core'
import {context} from '@actions/github'
import {RestEndpointMethodTypes} from "@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types"
import {GitError, SimpleGit} from 'simple-git'
import {isConventionalCommit} from './internal/conventional-commits'
import {newOctokitInstance} from './internal/octokit'
import {RepositorySynchronizer} from './internal/RepositorySynchronizer'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', {required: true})
core.setSecret(githubToken)

const conventionalCommits = core.getInput('conventionalCommits', {required: true}).toLowerCase() === 'true'
const syncBranchName = getSyncBranchName()

const octokit = newOctokitInstance(githubToken)

const pullRequestLabel = 'sync-with-template'
const emailSuffix = '+sync-with-template@users.noreply.github.com'
const conflictsResolutionEmailSuffix = '+sync-with-template-conflicts-resolution@users.noreply.github.com'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const templateRepositoryFullName = core.getInput('templateRepository')
        const ignorePathPatterns = core.getInput('ignorePaths').split('\n')
            .map(line => line.replace(/#.*/, '').trim())
            .filter(line => line.length > 0)

        const synchronizer = new RepositorySynchronizer(
            githubToken,
            templateRepositoryFullName,
            syncBranchName,
            ignorePathPatterns
        )

        const repo = await synchronizer.currentRepo
        if (repo.archived) {
            core.info(`Skipping template synchronization, as current repository is archived`)
            return
        }
        if (repo.fork) {
            core.info(`Skipping template synchronization, as current repository is a fork`)
            return
        }

        const templateRepo = await synchronizer.templateRepoOrNull
        if (templateRepo == null) {
            core.warning("Template repository name can't be retrieved: the current repository isn't created from a"
                + " template and 'templateRepository' input isn't set")
            return
        }
        core.info(`Using ${templateRepo.full_name} as a template repository`)

        await core.group("Initializing the repository", async () => {
            await synchronizer.initializeRepository()
        })


        await core.group("Fetching sync branch", async () => {
            const doesOriginHasSyncBranch = await synchronizer.doesSyncBranchExists()
            if (doesOriginHasSyncBranch) {
                await synchronizer.checkoutSyncBranch()
                return
            }

            const pullRequest = await synchronizer.latestMergedPullRequest
            if (pullRequest) {
                await synchronizer.checkoutPullRequestHead(pullRequest)
                return
            }

            await synchronizer.checkoutFirstRepositoryCommit()
        })


        const lastSynchronizedCommitDate: Date = await core.group(
            "Retrieving last synchronized commit date",
            async () => {
                const latestSyncCommit = await synchronizer.retrieveLatestSyncCommit()
                    || await synchronizer.firstRepositoryCommit
                core.info(`Last synchronized commit is: ${repo.html_url}/commit/${latestSyncCommit.hash} (${latestSyncCommit.date}): ${latestSyncCommit.message}`)
                return new Date(latestSyncCommit.date)
            }
        )


        const cherryPickedCommitCounts: number = await core.group("Cherry-picking template commits", async () => {
            const templateRemote = await synchronizer.template
            const templateBranchLog = await templateRemote.parseLog(undefined, true, lastSynchronizedCommitDate)

            let count = 0
            for (const logItem of templateBranchLog.all) {
                const logDate = new Date(logItem.date)
                if (logDate.getTime() <= lastSynchronizedCommitDate.getTime()) {
                    continue
                }

                ++count
                core.info(`Cherry-picking ${templateRepo.html_url}/commit/${logItem.hash} (${logItem.date}): ${logItem.message}`)
                await synchronizer.cherryPick(logItem)

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
                await synchronizer.commit(message, logItem.date)
            }
            return count
        })


        let createdPullRequestNumber: number | undefined = undefined
        if (cherryPickedCommitCounts === 0) {
            core.info("No commits were cherry-picked from template repository")

        } else {
            core.info(`Pushing ${cherryPickedCommitCounts} commits`)
            await synchronizer.origin.then(remote => remote.push(syncBranchName))

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
                                    await git.rm(conflictedPath)
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

//noinspection JSIgnoredPromiseFromCall
run()

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
