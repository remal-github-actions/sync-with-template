import * as core from '@actions/core'
import {isConventionalCommit} from './internal/conventional-commits'
import {RepositorySynchronizer} from './internal/RepositorySynchronizer'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const githubToken = core.getInput('githubToken', {required: true})
core.setSecret(githubToken)

const conventionalCommits = core.getInput('conventionalCommits', {required: true}).toLowerCase() === 'true'
const syncBranchName = getSyncBranchName()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const templateRepositoryFullName = core.getInput('templateRepository')
        const ignorePathPatterns = core.getInput('ignorePaths').split('\n')
            .map(line => line.replace(/#.*/, '').trim())
            .filter(line => line.length)

        const synchronizer = new RepositorySynchronizer(
            githubToken,
            templateRepositoryFullName,
            syncBranchName,
            ignorePathPatterns
        )

        const repo = await synchronizer.currentRepo
        core.info(`Using ${repo.full_name} as the current repository`)
        if (repo.archived) {
            core.info(`Skipping template synchronization, as current repository is archived`)
            return
        }
        if (repo.fork) {
            core.info(`Skipping template synchronization, as current repository is a fork`)
            return
        }
        const defaultBranchName = await synchronizer.origin.then(it => it.defaultBranch)
        core.info(`Using '${defaultBranchName}' as a default branch of the current repository`)


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
                const latestSyncCommit = (await synchronizer.retrieveLatestSyncCommit())
                    || (await synchronizer.firstRepositoryCommit)
                core.info(`Last synchronized commit is: ${repo.html_url}/commit/${latestSyncCommit.hash} (${latestSyncCommit.date}): ${latestSyncCommit.message}`)
                return new Date(latestSyncCommit.date)
            }
        )


        const cherryPickedCommitsCounts: number = await core.group("Cherry-picking template commits", async () => {
            const templateBranchLog = await synchronizer.template
                .then(it => it.parseLog(undefined, true, lastSynchronizedCommitDate))

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
        if (cherryPickedCommitsCounts === 0) {
            core.info("No commits were cherry-picked from template repository")
        }

        let additionalCommitsCount: number = 0
        if (synchronizer.isIgnorePathMatcherSet) {
            await core.group(
                `Trying to resolve merge conflicts from '${syncBranchName}' branch`
                + ` to '${defaultBranchName}' branch for ignored files`,
                async () => {
                    const isCommitAdded = await synchronizer.resolveMergeConflictsForIgnoredFiles()
                    if (isCommitAdded) {
                        additionalCommitsCount++
                    }
                }
            )
        }

        const changedFiles = await synchronizer.retrieveChangedFilesAfterMerge()
        if (!changedFiles.length) {
            core.info(`Removing '${syncBranchName}' branch, as no files will be changed after merging the changes`
                + ` from '${syncBranchName}' branch into '${defaultBranchName}' branch`
            )

            await synchronizer.origin.then(remote => remote.remove(syncBranchName))

            const openedPullRequest = await synchronizer.openedPullRequest
            if (openedPullRequest) {
                await synchronizer.closePullRequest(
                    openedPullRequest,
                    'autoclosed',
                    `Autoclosing the PR, as no files will be changed after merging the changes`
                    + ` from \`${syncBranchName}\` branch into \`${defaultBranchName}\` branch.`
                )
            }

        } else {
            const totalCommitCount = cherryPickedCommitsCounts + additionalCommitsCount
            if (totalCommitCount > 0) {
                core.info(`Pushing ${totalCommitCount} commits`)
                await synchronizer.origin.then(remote => remote.push(syncBranchName))

                const openedPullRequest = await synchronizer.openedPullRequest
                if (!openedPullRequest) {
                    let pullRequestTitle = `Merge template repository changes: ${templateRepo.full_name}`
                    if (conventionalCommits) {
                        pullRequestTitle = `chore(template): ${pullRequestTitle}`
                    }

                    const pullRequest = await synchronizer.createPullRequest({
                        head: syncBranchName,
                        base: defaultBranchName,
                        title: pullRequestTitle,
                        body: "Template repository changes."
                            + "\n\nIf you close this PR, it will be recreated automatically.",
                        maintainer_can_modify: true,
                    })

                    core.info(`Pull request for '${syncBranchName}' branch has been created: ${pullRequest.html_url}`)
                }
            } else {
                core.info('No commits were made, nothing to push')
            }
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
