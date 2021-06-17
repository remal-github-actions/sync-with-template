import * as core from '@actions/core'
import {context} from '@actions/github'
import {components, operations} from '@octokit/openapi-types/generated/types'
import picomatch from 'picomatch'
import simpleGit, {GitError, LogResult, SimpleGit, StatusResult} from 'simple-git'
import {DefaultLogFields} from 'simple-git/src/lib/tasks/log'
import {URL} from 'url'
import {cache} from './cache'
import {newOctokitInstance, Octokit} from './octokit'

export type Repo = components['schemas']['full-repository']
export type PullRequest = components['schemas']['pull-request']
export type PullRequestSimple = components['schemas']['pull-request-simple']
export type NewPullRequest = operations['pulls/create']['requestBody']['content']['application/json']

export class RepositorySynchronizer {

    private readonly githubToken: string
    private readonly templateRepositoryFullName: string | undefined
    private readonly octokit: Octokit
    private readonly syncBranchName: string
    private readonly ignorePathMatcher: GlobMatcher | undefined

    constructor(
        githubToken: string,
        templateRepositoryFullName: string | undefined,
        syncBranchName: string,
        ignorePathPatterns: string[]
    ) {
        this.githubToken = githubToken
        this.templateRepositoryFullName = templateRepositoryFullName
        this.syncBranchName = syncBranchName

        core.setSecret(githubToken)
        this.octokit = newOctokitInstance(githubToken)

        if (ignorePathPatterns.length) {
            core.info(`Ignored files:\n  ${ignorePathPatterns.join('\n  ')}`)
            this.ignorePathMatcher = picomatch(ignorePathPatterns)
        } else {
            this.ignorePathMatcher = undefined
        }
    }

    get isIgnorePathMatcherSet(): boolean {
        return this.ignorePathMatcher != null
    }

    @cache
    get workspacePath(): string {
        const workspacePath = require('tmp').dirSync().name
        debug(`Workspace path: ${workspacePath}`)
        return workspacePath
    }

    @cache
    get git(): SimpleGit {
        if (process.env.ACTIONS_STEP_DEBUG?.toLowerCase() === 'true') {
            require('debug').enable('simple-git,simple-git:*')
            process.env.DEBUG = [
                process.env.DEBUG || '',
                'simple-git',
                'simple-git:*'
            ].filter(it => it.length).join(',')
        }

        const git = simpleGit(this.workspacePath)
            .env(DEFAULT_GIT_ENV)

        return git
    }


    async initializeRepository() {
        const repo = await this.currentRepo
        const templateRepo = await this.templateRepo
        const git = this.git

        await git.init()
        await git.addConfig('gc.auto', '0')
        await git.addConfig('user.useConfigOnly', 'true')
        await git.addConfig('diff.algorithm', 'patience')
        //await git.addConfig('core.pager', 'cat')
        await git.addConfig('fetch.recurseSubmodules', 'no')

        core.info('Setting up credentials')
        const basicCredentials = Buffer.from(`x-access-token:${this.githubToken}`, 'utf8').toString('base64')
        core.setSecret(basicCredentials)
        for (const origin of [new URL(repo.svn_url).origin, new URL(templateRepo.svn_url).origin]) {
            await git.addConfig(`http.${origin}/.extraheader`, `Authorization: basic ${basicCredentials}`)
        }

        await this.initializeUserInfo()
    }

    private currentUserName: string | undefined = undefined
    private previousUserEmail: string | undefined = undefined

    async initializeUserInfo(userEmailSuffix: string = SYNCHRONIZATION_EMAIL_SUFFIX) {
        const repo = await this.currentRepo

        const userName = repo.owner != null
            ? repo.owner.login
            : context.repo.owner
        if (userName !== this.currentUserName) {
            await this.git.addConfig('user.name', userName)
            this.currentUserName = userName
        }

        const userEmail = repo.owner != null
            ? `${repo.owner.id}+${repo.owner.login}${userEmailSuffix}`
            : `${context.repo.owner}${userEmailSuffix}`
        if (userEmail !== this.previousUserEmail) {
            await this.git.addConfig('user.email', userEmail)
            this.previousUserEmail = userEmail
        }
    }


    @cache
    get origin(): Promise<Remote> {
        return this.currentRepo.then(repo => {
            return new Remote(this, 'origin', repo)
        })
    }

    @cache
    get template(): Promise<Remote> {
        return this.templateRepo.then(repo => {
            return new Remote(this, 'template', repo)
        })
    }


    doesSyncBranchExists(): Promise<boolean> {
        return this.origin
            .then(it => it.remoteBranches)
            .then(remoteBranches => remoteBranches.includes(this.syncBranchName))
    }

    async checkoutSyncBranch() {
        await this.origin.then(it => it.checkout(this.syncBranchName))
    }


    async checkoutPullRequestHead(pullRequest: PullRequest | PullRequestSimple, branchName?: string) {
        const trueBranchName = branchName || this.syncBranchName
        const mergeCommitSha = pullRequest.merge_commit_sha
        if (mergeCommitSha == null) {
            throw new Error(`Merge commit SHA is empty for pull request ${pullRequest.html_url}`)
        }
        try {
            debug(`Checkouting merge commit of ${pullRequest.html_url}: ${mergeCommitSha}`)
            await this.origin.then(remote => remote.fetch())
            await forceCheckout(this.git, trueBranchName, mergeCommitSha)

        } catch (error) {
            if (error instanceof GitError
                && error.message.includes(`reference is not a tree ${mergeCommitSha}`)
            ) {
                debug(`Checkouting HEAD commit of ${pullRequest.html_url}: ${mergeCommitSha}`)
                await this.fetchPullRequest(pullRequest)
                await forceCheckout(this.git, trueBranchName, pullRequest.head.sha)

            } else {
                throw error
            }
        }
    }

    private async fetchPullRequest(pullRequest: PullRequest | PullRequestSimple) {
        core.info(`Fetching last commit of pull request ${pullRequest.html_url}`)
        const remote = await this.origin
        await remote.fetch(`refs/pull/${pullRequest.number}/head`)
    }


    parseLog(ref?: string, reverse?: boolean, since?: Date): Promise<LogResult> {
        const options: string[] = []

        if (reverse) {
            options.push('--reverse')
        }

        if (since) {
            const timestamp = since.getTime() / 1000
            options.push(`--since=${timestamp}`)
        }

        if (ref) {
            options.push(ref)
        }

        return this.git.log(options)
    }

    retrieveLatestSyncCommit(): Promise<DefaultLogFields | undefined> {
        return this.parseLog().then(log => {
            for (const logItem of log.all) {
                if (logItem.author_email.endsWith(SYNCHRONIZATION_EMAIL_SUFFIX)) {
                    return logItem
                }
            }
            return undefined
        })
    }


    @cache
    get firstRepositoryCommit(): Promise<DefaultLogFields> {
        return this.origin
            .then(remote => remote.parseLog(undefined, true))
            .then(log => log.latest!!)
    }

    async checkoutFirstRepositoryCommit(): Promise<DefaultLogFields> {
        const repo = await this.currentRepo
        core.info(`Creating '${this.syncBranchName}' branch from the first commit of default branch '${repo.default_branch}'`)
        const firstRepositoryCommit = await this.firstRepositoryCommit
        await forceCheckout(this.git, this.syncBranchName, firstRepositoryCommit.hash)
        return firstRepositoryCommit
    }


    retrieveChangedFiles(logItem: DefaultLogFields): Promise<string[]> {
        return this.git.raw('diff-tree', '--no-commit-id', '--name-only', '-r', logItem.hash)
            .then(content => content.trim().split('\n')
                .map(line => line.trim())
                .filter(line => line.length)
            )
    }

    async checkIfCommitHasOnlyIgnoredFiles(logItem: DefaultLogFields): Promise<boolean> {
        const ignorePathMatcher = this.ignorePathMatcher
        if (ignorePathMatcher == null) {
            return false
        }

        const changedFiles = await this.retrieveChangedFiles(logItem)
        const notIgnoredFile = changedFiles.find(filePath => !ignorePathMatcher(filePath))
        return notIgnoredFile == null
    }


    async cherryPick(logItem: DefaultLogFields) {
        core.info(`Cherry-picking: ${logItem.message} (commit made at ${logItem.date})`)
        try {
            await this.git.raw(
                'cherry-pick',
                '--no-commit',
                '-r',
                '--allow-empty',
                '--allow-empty-message',
                '--keep-redundant-commits',
                '--strategy=recursive',
                '-Xours',
                logItem.hash
            )

        } catch (error) {
            if (error instanceof GitError
                && error.message.includes(`error: could not apply ${logItem.hash.substring(0, 6)}`)
            ) {
                debug(`  Collecting rename/delete conflicts`)
                const renamedDeletedPaths: string[] = []
                const renamedDeletedPathsMatches = error.message.matchAll(
                    /CONFLICT \(rename\/delete\): ([^\n]*?) deleted in HEAD and renamed to ([^\n]*?) in ([^\n]*?)\. Version \3 of \2 left in tree\./g
                )
                for (const renamedDeletedPathsMatch of renamedDeletedPathsMatches) {
                    const deletedPath = renamedDeletedPathsMatch[1]
                    const renamedPath = renamedDeletedPathsMatch[2]
                    renamedDeletedPaths.push(renamedPath)
                    debug(`    deletedPath=${deletedPath}; renamedPath=${renamedPath}`)
                }

                debug('  Trying to resolve merge conflicts')
                const unstagedFiles = await this.unstageIgnoredFiles()
                const status = await this.git.status()
                const unresolvedConflictedFiles: string[] = []
                for (const conflictedPath of status.conflicted) {
                    debug(`  conflictedPath=${conflictedPath}`)
                    if (unstagedFiles.includes(conflictedPath)) {
                        debug(`      UNSTAGED`)
                        continue
                    }

                    if (renamedDeletedPaths.includes(conflictedPath)) {
                        core.info(`  Resolving conflict: removing file: ${conflictedPath}`)
                        await this.git.rm(conflictedPath)
                        continue
                    }

                    const fileInfo = status.files.find(file => file.path === conflictedPath)
                    debug(`      fileInfo.working_dir=${fileInfo?.working_dir}`)
                    debug(`      fileInfo.index=${fileInfo?.index}`)
                    if (fileInfo !== undefined && fileInfo.working_dir === 'U') {
                        if (fileInfo.index === 'A') {
                            core.info(`  Resolving conflict: adding file: ${conflictedPath}`)
                            await this.git.add(conflictedPath)
                            continue
                        } else if (fileInfo.index === 'D') {
                            core.info(`  Resolving conflict: removing file: ${conflictedPath}`)
                            await this.git.rm(conflictedPath)
                            continue
                        }
                    }
                    core.error(`  Unresolved conflict: ${conflictedPath}`)
                    unresolvedConflictedFiles.push(conflictedPath)
                }
                if (unresolvedConflictedFiles.length === 0) {
                    return
                } else {
                    throw error
                }
            } else {
                throw error
            }
        }

        await this.unstageIgnoredFiles()
    }

    private async unstageIgnoredFiles(): Promise<string[]> {
        const ignorePathMatcher = this.ignorePathMatcher
        if (ignorePathMatcher === undefined) {
            return Promise.resolve([])
        }

        const unstagedFiles: string[] = []
        const status = await this.git.status()
        for (const filePath of status.staged) {
            if (ignorePathMatcher(filePath)) {
                core.info(`  Ignored file: unstaging: ${filePath}`)
                await this.git.raw('reset', '-q', 'HEAD', '--', filePath)
                if (status.created.includes(filePath)) {
                    core.info(`    Removing created: ${filePath}`)
                    await this.git.rm(filePath)
                } else {
                    core.info(`    Reverting modified/deleted: ${filePath}`)
                    await this.git.raw('checkout', 'HEAD', '--', filePath)
                }
                unstagedFiles.push(filePath)
            }
        }
        return Promise.resolve(unstagedFiles)
    }


    async commit(message: string, date?: string | Date, userEmailSuffix: string = SYNCHRONIZATION_EMAIL_SUFFIX) {
        await this.initializeUserInfo(userEmailSuffix)

        if (date) {
            this.git.env(Object.assign(
                {
                    GIT_AUTHOR_DATE: date.toString(),
                    GIT_COMMITTER_DATE: date.toString(),
                },
                DEFAULT_GIT_ENV
            ))
        }

        await this.git.commit(message, {
            '--allow-empty': null,
        })

        this.git.env(DEFAULT_GIT_ENV)
    }


    async retrieveChangedFilesAfterMerge(targetBranch: string, sourceRef: string): Promise<string[]> {
        const currentBranch = await this.currentBranch
        await this.origin.then(remote => remote.checkout(targetBranch))
        const mergeStatus = await this.mergeAndGetStatus(sourceRef)

        const changedFiles: string[] = []
        const ignorePathMatcher = this.ignorePathMatcher
        for (const filePath of [...mergeStatus.staged, ...mergeStatus.conflicted]) {
            if (!changedFiles.includes(filePath)) {
                const isIncluded = !ignorePathMatcher || ignorePathMatcher(filePath)
                if (isIncluded) {
                    changedFiles.push(filePath)
                }
            }
        }

        await this.abortMerge()
        await this.git.raw('checkout', '-f', currentBranch)

        return changedFiles
    }


    async resolveMergeConflictsForIgnoredFiles(ref?: string): Promise<boolean> {
        const ignorePathMatcher = this.ignorePathMatcher
        if (ignorePathMatcher == null) {
            return false
        }

        const mergeStatus = await this.origin.then(remote => remote.mergeAndGetStatus(ref))
        const conflicted = mergeStatus.conflicted
        if (!conflicted.length) {
            core.info('No merge conflicts detected')
            await this.abortMerge()
            return false
        }

        const ignoredConflicted = conflicted.filter(it => ignorePathMatcher(it))
        const notIgnoredConflicted = conflicted.filter(it => !ignoredConflicted.includes(it))
        if (notIgnoredConflicted.length) {
            core.error(`Automatic merge-conflict resolution for ignored files failed`
                + `, as there are some conflict in included`
                + ` files:\n  ${notIgnoredConflicted.join('\n  ')}`
            )
            await this.abortMerge()
            return false
        }

        for (const conflictedPath of ignoredConflicted) {
            const fileInfo = mergeStatus.files.find(file => file.path === conflictedPath)
            if (fileInfo && fileInfo.working_dir === 'D') {
                core.info(`Resolving conflict: removing file: ${conflictedPath}`)
                await this.git.rm(conflictedPath)
            } else {
                const remote = await this.origin
                core.info(`Resolving conflict: using file from '${remote.defaultBranch}' branch: ${conflictedPath}`)
                await this.git.raw(
                    'checkout',
                    '-f',
                    this.syncBranchName,
                    '--',
                    conflictedPath
                )
            }
        }

        core.info('Committing changes')
        await this.initializeUserInfo(CONFLICTS_RESOLUTION_EMAIL_SUFFIX)
        await this.git.raw('commit', '--no-edit')

        return true
    }

    async mergeAndGetStatus(ref?: string): Promise<StatusResult> {
        const trueRef = ref || (await this.currentRepo).default_branch

        try {
            await this.initializeUserInfo(CONFLICTS_RESOLUTION_EMAIL_SUFFIX)
            await this.git.raw('merge', '--no-commit', '--no-ff', trueRef)

        } catch (reason) {
            if (reason instanceof GitError
                && reason.message.includes('Automatic merge failed; fix conflicts')
            ) {
                // Merge conflicts will be resolved later
            } else {
                throw reason
            }
        }

        return this.git.status()
    }

    async abortMerge() {
        try {
            await this.git.raw('merge', '--abort')

        } catch (reason) {
            if (reason instanceof GitError
                && reason.message.includes('There is no merge to abort')
            ) {
                // OK
            } else {
                throw reason
            }
        }
    }


    get latestMergedPullRequest(): Promise<PullRequest | PullRequestSimple | undefined> {
        return this.mergedPullRequests.then(prs => prs.length ? prs[0] : undefined)
    }

    @cache
    private get mergedPullRequests(): Promise<PullRequestSimple[]> {
        return this.octokit.paginate(this.octokit.pulls.list, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            state: 'closed',
            head: `${context.repo.owner}:${this.syncBranchName}`
        })
            .then(prs => prs.filter(pr => pr.head.ref === this.syncBranchName))
            .then(prs => prs.filter(pr => pr.head.sha !== pr.base.sha))
            .then(prs => prs.filter(pr => pr.merged_at != null))
            .then(prs => [...prs].sort((pr1, pr2) => {
                const mergedAt1 = new Date(pr1.merged_at!).getTime()
                const mergedAt2 = new Date(pr2.merged_at!).getTime()
                if (mergedAt1 < mergedAt2) {
                    return 1
                } else if (mergedAt1 > mergedAt2) {
                    return -1
                } else {
                    return pr2.number - pr1.number
                }
            }))
    }

    async createPullRequest(info: NewPullRequest): Promise<PullRequest> {
        const pullRequest = await this.octokit.pulls.create(Object.assign(
            {
                owner: context.repo.owner,
                repo: context.repo.repo,
            },
            info
        )).then(it => it.data)

        await this.octokit.issues.addLabels({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: pullRequest.number,
            labels: [PULL_REQUEST_LABEL],
        })

        return pullRequest
    }


    @cache
    get openedPullRequest(): Promise<PullRequestSimple | undefined> {
        return this.octokit.paginate(this.octokit.pulls.list, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            state: 'open',
            head: `${context.repo.owner}:${this.syncBranchName}`,
            sort: 'created',
            direction: 'desc',
        })
            .then(prs => prs.filter(pr => pr.head.ref === this.syncBranchName))
            .then(prs => {
                const promises = prs.map((pr, index) =>
                    index === 0
                        ? Promise.resolve(pr)
                        : this.closePullRequest(pr, 'autoclosed redundant')
                )
                return Promise.all(promises as Promise<any>[])
            })
            .then(promises => {
                if (promises.length) {
                    return promises[0] as PullRequestSimple
                } else {
                    return undefined
                }
            })
    }

    async closePullRequest(
        pullRequest: PullRequest | PullRequestSimple,
        titleSuffix?: string,
        message?: string
    ): Promise<PullRequest> {
        core.info(`Closing pull request ${pullRequest.html_url}`)

        if (message) {
            await this.octokit.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: pullRequest.number,
                body: message
            })
        }

        return this.octokit.pulls.update({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: pullRequest.number,
            state: 'closed',
            title: titleSuffix
                ? `${pullRequest.title} - ${titleSuffix}`
                : pullRequest.title
        }).then(it => it.data)
    }


    get currentBranch(): Promise<string> {
        return this.git.raw('rev-parse', '--abbrev-ref', 'HEAD')
            .then(text => text.trim())
    }


    @cache
    get currentRepo(): Promise<Repo> {
        return this.getRepo(context.repo.owner, context.repo.repo)
    }

    get templateRepo(): Promise<Repo> {
        return this.templateRepoOrNull.then(repo => {
            if (repo == null) {
                throw new Error('Template repository is not defined')
            }
            return repo
        })
    }

    @cache
    get templateRepoOrNull(): Promise<Repo | null> {
        return this.currentRepo.then(currentRepo => {
            const templateRepoName = this.templateRepositoryFullName
            if (templateRepoName === currentRepo.template_repository?.full_name) {
                return currentRepo.template_repository as any as Repo

            } else if (!templateRepoName) {
                if (currentRepo.template_repository != null) {
                    return currentRepo.template_repository as any as Repo
                }

            } else {
                const [owner, repo] = templateRepoName.split('/')
                return this.getRepo(owner, repo)
            }

            return null
        })
    }

    private getRepoCache: Record<string, Repo> = {}

    private getRepo(owner: string, repo: string): Promise<Repo> {
        const cacheKey = `${owner}/${repo}`
        if (cacheKey in this.getRepoCache) {
            return Promise.resolve(this.getRepoCache[cacheKey])
        }

        return this.octokit.repos.get({owner, repo})
            .then(it => it.data)
            .then(it => {
                this.getRepoCache[cacheKey] = it
                return it
            })
    }

}

export class Remote {

    readonly name: RemoteName
    readonly defaultBranch: string

    private readonly synchronizer: RepositorySynchronizer
    private readonly git: SimpleGit
    private readonly repo: Repo

    constructor(synchronizer: RepositorySynchronizer, name: RemoteName, repo: Repo) {
        this.name = name
        this.defaultBranch = repo.default_branch

        this.synchronizer = synchronizer
        this.git = synchronizer.git
        this.repo = repo
    }

    private isRemoteAdded: boolean = false

    private async addRemoteIfNotAdded() {
        if (!this.isRemoteAdded) {
            debug(`Adding '${this.name}' remote: ${this.repo.svn_url}`)
            await this.git.addRemote(this.name, this.repo.svn_url)
            this.isRemoteAdded = true
        }
    }

    private readonly fetchedRefs: string[] = []

    async fetch(ref?: string) {
        const trueRef = ref || this.defaultBranch
        if (!this.fetchedRefs.includes(trueRef)) {
            await this.addRemoteIfNotAdded()
            debug(`Fetching from '${this.name}' remote: ${trueRef}`)
            await this.git.fetch(this.name, trueRef)
            this.fetchedRefs.push(trueRef)
        }
    }

    async checkout(ref?: string) {
        const trueRef = ref || this.defaultBranch
        await this.fetch(trueRef)
        await forceCheckout(this.git, trueRef, `remotes/${this.name}/${trueRef}`)
    }

    private _remoteBranches: string[] | undefined = undefined

    get remoteBranches(): Promise<string[]> {
        return this.addRemoteIfNotAdded().then(() => {
            if (this._remoteBranches !== undefined) {
                return Promise.resolve(this._remoteBranches)

            } else {
                const branchPrefix = `refs/heads/`
                return this.git.listRemote(['--exit-code', '--heads', this.name]).then(content => {
                    return content.split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0)
                        .map(line => line.split('\t')[1])
                        .map(line => line.trim())
                        .filter(line => line.length > 0)
                })
                    .then(branches => branches.map(branch => {
                        if (branch.startsWith(branchPrefix)) {
                            return branch.substring(branchPrefix.length)
                        } else {
                            return branch
                        }
                    }))
                    .then(branches => {
                        this._remoteBranches = branches
                        return branches
                    })
            }
        })
    }

    parseLog(ref?: string, reverse?: boolean, since?: Date): Promise<LogResult> {
        const trueRef = ref || this.defaultBranch
        return this.fetch(trueRef)
            .then(() => this.synchronizer.parseLog(`remotes/${this.name}/${trueRef}`, reverse, since))
    }

    async push(ref?: string) {
        const currentBranch = await this.git.raw('rev-parse', '--abbrev-ref', 'HEAD').then(content => content.trim())
        const trueRef = ref || currentBranch

        await this.git.raw('push', this.name, trueRef)

        const remoteBranchesCache = this._remoteBranches
        if (remoteBranchesCache !== undefined) {
            remoteBranchesCache.push(trueRef)
        }
        if (!this.fetchedRefs.includes(trueRef)) {
            this.fetchedRefs.push(trueRef)
        }
    }

    async remove(ref?: string) {
        const currentBranch = await this.git.raw('rev-parse', '--abbrev-ref', 'HEAD').then(content => content.trim())
        const trueRef = ref || currentBranch

        const remoteBranches = await this.remoteBranches
        if (!remoteBranches.includes(trueRef)) {
            return
        }

        core.info(`Removing '${trueRef}' branch from '${this.name}' remote`)
        await this.git.raw('push', '-d', this.name, trueRef)

        const remoteBranchesCache = this._remoteBranches
        if (remoteBranchesCache !== undefined) {
            const index = remoteBranchesCache.indexOf(trueRef)
            if (index >= 0) {
                remoteBranchesCache.splice(index)
            }
        }
    }

    async mergeAndGetStatus(ref?: string): Promise<StatusResult> {
        const trueRef = ref || this.defaultBranch
        await this.fetch(trueRef)
        return this.synchronizer.mergeAndGetStatus(`remotes/${this.name}/${trueRef}`)
    }

}

type GlobMatcher = (filePath: string) => boolean

type RemoteName = 'origin' | 'template'

const PULL_REQUEST_LABEL = 'sync-with-template'
const SYNCHRONIZATION_EMAIL_SUFFIX = '+sync-with-template@users.noreply.github.com'
const CONFLICTS_RESOLUTION_EMAIL_SUFFIX = '+sync-with-template-conflicts-resolution@users.noreply.github.com'
const DEFAULT_GIT_ENV: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASK_YESNO: 'false',
}

async function forceCheckout(git: SimpleGit, branchName: string, ref: string) {
    core.info(`Checkouting '${branchName}' branch from '${ref}' Git ref`)
    await git.raw('checkout', '-f', '-B', branchName, ref)

    const status = await git.status()
    const notAdded = status.not_added
    if (notAdded.length) {
        debug(`Removing not added files:\n  ${notAdded.join('\n  ')}`)
        await git.add(notAdded)
        await git.rm(notAdded)
    }
}


function debug(message: string) {
    if (process.env.ACTIONS_STEP_DEBUG?.toLowerCase() === 'true') {
        core.info(message)
    } else {
        core.debug(message)
    }
}
