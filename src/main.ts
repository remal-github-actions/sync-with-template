import * as core from '@actions/core'
import {newOctokitInstance} from './internal/octokit'
import {context} from '@actions/github'
import {RestEndpointMethodTypes} from "@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types"
import simpleGit, {GitError} from 'simple-git'
import './internal/simple-git-extensions'

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const pushToken = core.getInput('githubToken', {required: true})
core.setSecret(pushToken)

const conventionalCommits = core.getInput('conventionalCommits', {required: true}).toLowerCase() === 'true'
const syncBranchName = getSyncBranchName()

const octokit = newOctokitInstance(pushToken)

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
                await git.addConfig('user.email', `${repo.owner.id}+${repo.owner.login}@users.noreply.github.com`)
            } else {
                await git.addConfig('user.name', context.repo.owner)
                await git.addConfig('user.email', `${context.repo.owner}@users.noreply.github.com`)
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

            core.info("Adding origin remote")
            await git.addRemote('origin', repo.svn_url)
            await git.ping('origin')

            core.info("Adding template remote")
            await git.addRemote('template', templateRepo.svn_url)
            await git.ping('template')

            core.info("Installing LFS")
            await git.installLfs()
        })

        await core.group("Fetching sync branch", async () => {
            try {
                await git.fetch('origin', syncBranchName, {'--depth': 1})
            } catch (e) {
                if (e instanceof GitError) {
                    core.debug(e.message)
                } else {
                    throw e
                }
            }

            const pullRequests = await octokit.paginate(octokit.pulls.list, {
                owner: context.repo.owner,
                repo: context.repo.repo,
                state: 'closed',
                head: `${context.repo.owner}:${syncBranchName}`
            })
            const mergedPullRequests = pullRequests
                .filter(pr => pr.head.ref === syncBranchName)
                .filter(pr => pr.head.sha !== pr.base.sha)
                .filter(pr => pr.merged_at != null)
            const sortedPullRequests = [...mergedPullRequests].sort((pr1, pr2) => {
                const mergedAt1 = pr1.merged_at!!
                const mergedAt2 = pr2.merged_at!!
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
                core.info(`Restoring '${syncBranchName}' branch from pull request ${pullRequest.html_url}`)
                const pullRequestBranchName = `refs/pull/${pullRequest.number}/head`
                await git.fetch('origin', pullRequestBranchName, {'--depth': 1})
                await git.checkoutBranch(syncBranchName, pullRequest.head.sha)
                return
            }

            const defaultBranchName = repo.default_branch
            core.info(`Creating '${syncBranchName}' branch from the first commit of default branch '${defaultBranchName}'`)
            await git.fetch('origin', defaultBranchName)
            const defaultBranchLog = await git.log(['--reverse', `remotes/origin/${defaultBranchName}`])
            core.info(defaultBranchLog.latest?.hash || '<no hash>')
            core.info(defaultBranchLog.latest?.date || '<no date>')
        })

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
