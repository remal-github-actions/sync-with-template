import * as core from '@actions/core'
import {context} from '@actions/github'
import {components} from '@octokit/openapi-types/generated/types'
import fs from 'fs'
import isWindows from 'is-windows'
import path from 'path'
import picomatch from 'picomatch'
import simpleGit, {GitError, LogResult, SimpleGit} from 'simple-git'
import {DefaultLogFields} from 'simple-git/src/lib/tasks/log'
import {URL} from 'url'
import {cache} from './cache'
import {newOctokitInstance, Octokit} from './octokit'

export type Repo = components['schemas']['full-repository']
export type PullRequest = components['schemas']['pull-request']
export type PullRequestSimple = components['schemas']['pull-request-simple']

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
            this.ignorePathMatcher = picomatch(ignorePathPatterns, {windows: isWindows()})
        } else {
            this.ignorePathMatcher = undefined
        }
    }


    @cache
    get workspacePath(): string {
        const workspacePath = require('tmp').dirSync().name
        core.debug(`Workspace path: ${workspacePath}`)
        return workspacePath
    }

    @cache
    get git(): SimpleGit {
        if (process.env.ACTIONS_STEP_DEBUG?.toLowerCase() === 'true') {
            require('debug').enable('simple-git')
            process.env.DEBUG = [
                process.env.DEBUG || '',
                'simple-git',
                'simple-git:*'
            ].filter(it => it.length).join(',')
        }
        return simpleGit(this.workspacePath)
    }


    async initializeRepository() {
        const repo = await this.currentRepo
        const templateRepo = await this.templateRepo
        const git = this.git

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

        core.info('Setting up credentials')
        const basicCredentials = Buffer.from(`x-access-token:${this.githubToken}`, 'utf8').toString('base64')
        core.setSecret(basicCredentials)
        for (const origin of [new URL(repo.svn_url).origin, new URL(templateRepo.svn_url).origin]) {
            await git.addConfig(`http.${origin}/.extraheader`, `Authorization: basic ${basicCredentials}`)
        }
    }

    async initializeLfs() {
        core.info('Initialize LFS')
        await this.git.raw('lfs', 'install', '--local')
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


    async doesSyncBranchExists(): Promise<boolean> {
        const remote = await this.origin
        const remoteBranches = await remote.remoteBranches
        return remoteBranches.includes(this.syncBranchName)
    }

    async checkoutSyncBranch() {
        const remote = await this.origin
        await remote.checkout(this.syncBranchName)
    }


    async fetchPullRequest(pullRequest: PullRequest | PullRequestSimple) {
        const repo = await this.currentRepo
        core.info(`Fetching last commit of pull request #${pullRequest.number}: ${repo.html_url}/commit/${pullRequest.head.sha}`)
        const remote = await this.origin
        await remote.fetch(`refs/pull/${pullRequest.number}/head`)
    }

    async checkoutPullRequestHead(pullRequest: PullRequest | PullRequestSimple, branchName?: string) {
        const trueBranchName = branchName || this.syncBranchName
        await this.fetchPullRequest(pullRequest)
        await forceCheckout(this.git, trueBranchName, pullRequest.head.sha)
    }


    async parseLog(ref?: string, reverse?: boolean, since?: Date): Promise<LogResult> {
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

    async retrieveLatestSyncCommit(): Promise<DefaultLogFields | undefined> {
        const log = await this.parseLog()
        for (const logItem of log.all) {
            if (logItem.author_email.endsWith(emailSuffix)) {
                return logItem
            }
        }
        return undefined
    }


    @cache
    get firstRepositoryCommit(): Promise<DefaultLogFields> {
        return this.origin
            .then(remote => remote.parseLog())
            .then(log => log.latest!!)
    }

    async checkoutFirstRepositoryCommit(): Promise<DefaultLogFields> {
        const repo = await this.currentRepo
        core.info(`Creating '${this.syncBranchName}' branch from the first commit of default branch '${repo.default_branch}'`)
        const firstRepositoryCommit = await this.firstRepositoryCommit
        await forceCheckout(this.git, this.syncBranchName, firstRepositoryCommit.hash)
        return firstRepositoryCommit
    }


    async cherryPick(logItem: DefaultLogFields) {
        try {
            await this.git.raw(
                'cherry-pick',
                '--no-commit',
                '-r',
                '--allow-empty',
                '--allow-empty-message',
                '--strategy=recursive',
                '-Xours',
                logItem.hash
            )

        } catch (error) {
            if (error instanceof GitError
                && error.message.includes(`could not apply ${logItem.hash.substring(0, 6)}`)
            ) {
                const unstagedFiles = await this.unstageIgnoredFiles()

                const status = await this.git.status()
                const unresolvedConflictedFiles: string[] = []
                for (const conflictedPath of status.conflicted) {
                    if (unstagedFiles.includes(conflictedPath)) {
                        continue
                    }
                    const fileInfo = status.files.find(file => file.path === conflictedPath)
                    if (fileInfo !== undefined && fileInfo.working_dir === 'U') {
                        if (fileInfo.index === 'A') {
                            core.info(`Resolving conflict: adding file: ${conflictedPath}`)
                            await this.git.add(conflictedPath)
                            continue
                        } else if (fileInfo.index === 'D') {
                            core.info(`Resolving conflict: removing file: ${conflictedPath}`)
                            await this.git.rm(conflictedPath)
                            continue
                        }
                    }
                    core.error(`Unresolved conflict: ${conflictedPath}`)
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
                core.info(`Ignored file: unstaging: ${filePath}`)
                await this.git.raw('reset', '-q', 'HEAD', '--', filePath)
                if (status.created.includes(filePath)) {
                    core.info(`Ignored file: removing created: ${filePath}`)
                    const absoluteFilePath = path.resolve(this.workspacePath, filePath)
                    fs.unlinkSync(absoluteFilePath)
                } else {
                    core.info(`Ignored file: reverting modified/deleted: ${filePath}`)
                    await this.git.raw('checkout', 'HEAD', '--', filePath)
                }
                unstagedFiles.push(filePath)
            }
        }
        return Promise.resolve(unstagedFiles)
    }


    async commit(message: string, date?: string | Date) {
        let git = this.git
        if (date) {
            git = git
                .env('GIT_AUTHOR_DATE', date.toString())
                .env('GIT_COMMITTER_DATE', date.toString())
        }

        await git.commit(message, {
            '--allow-empty': null,
        })
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


    get openedPullRequest(): Promise<PullRequest | PullRequestSimple | undefined> {
        return this.openedPullRequests.then(prs => prs.length ? prs[0] : undefined)
    }

    async closeRedundantOpenedPullRequests() {
        const openedPullRequests = await this.openedPullRequests
        for (let index = 1; index < openedPullRequests.length; ++index) {

        }
    }

    @cache
    private get openedPullRequests(): Promise<PullRequestSimple[]> {
        return this.octokit.paginate(this.octokit.pulls.list, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            state: 'open',
            head: `${context.repo.owner}:${this.syncBranchName}`,
            sort: 'created',
            direction: 'desc',
        })
            .then(prs => prs.filter(pr => pr.head.ref === this.syncBranchName))
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

    private readonly synchronizer: RepositorySynchronizer
    private readonly git: SimpleGit
    private readonly name: string
    private readonly repo: Repo

    constructor(synchronizer: RepositorySynchronizer, name: string, repo: Repo) {
        this.synchronizer = synchronizer
        this.git = synchronizer.git
        this.name = name
        this.repo = repo
    }

    private isRemoteAdded: boolean = false

    private async addRemoteIfNotAdded() {
        if (!this.isRemoteAdded) {
            core.debug(`Adding '${this.name}' remote: ${this.repo.svn_url}`)
            await this.git.addRemote(this.name, this.repo.svn_url)
            this.isRemoteAdded = true
        }
    }

    private fetchedRefs: string[] = []

    async fetch(ref?: string) {
        const trueRef = ref || this.repo.default_branch
        if (!this.fetchedRefs.includes(trueRef)) {
            await this.addRemoteIfNotAdded()
            core.debug(`Fetching from '${this.name}' remote: ${trueRef}`)
            await this.git.fetch(this.name, trueRef)
            this.fetchedRefs.push(trueRef)
        }
    }

    async checkout(ref?: string) {
        const trueRef = ref || this.repo.default_branch
        await this.fetch(trueRef)
        await forceCheckout(this.git, trueRef, `remotes/origin/${trueRef}`)
    }

    private _remoteBranches: string[] | undefined = undefined

    get remoteBranches(): Promise<string[]> {
        return this.addRemoteIfNotAdded().then(() => {
            if (this._remoteBranches !== undefined) {
                return Promise.resolve(this._remoteBranches)

            } else {
                return this.git.listRemote(['--exit-code', '--heads', this.name]).then(content => {
                    return content.split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0)
                        .map(line => line.split('\t')[1])
                        .map(line => line.trim())
                        .filter(line => line.length > 0)
                })
                    .then(branches => {
                        this._remoteBranches = branches
                        return branches
                    })
            }
        })
    }

    async parseLog(ref?: string, reverse?: boolean, since?: Date): Promise<LogResult> {
        const trueRef = ref || this.repo.default_branch
        return this.synchronizer.parseLog(`remotes/origin/${trueRef}`, reverse, since)
    }

    async push(ref?: string) {
        const params: string[] = ['push', this.name]
        if (ref) {
            params.push(ref)
        }
        await this.git.raw(params)
    }

}

type GlobMatcher = (filePath: string) => boolean

const pullRequestLabel = 'sync-with-template'
const emailSuffix = '+sync-with-template@users.noreply.github.com'
const conflictsResolutionEmailSuffix = '+sync-with-template-conflicts-resolution@users.noreply.github.com'

async function forceCheckout(git: SimpleGit, branchName: string, ref: string) {
    await git.raw('checkout', '-f', '-B', branchName, ref)

    const status = await git.status()
    const notAdded = status.not_added
    if (notAdded.length) {
        core.debug(`Removing not added files:\n  ${notAdded.join('\n  ')}`)
        await git.add(notAdded)
        await git.rm(notAdded)
    }
}
