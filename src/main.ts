import * as core from '@actions/core'
import {context} from '@actions/github'
import * as glob from '@actions/glob'
import {components, operations} from '@octokit/openapi-types'
import Ajv2020 from 'ajv/dist/2020'
import * as fs from 'fs'
import path from 'path'
import picomatch from 'picomatch'
import simpleGit, {SimpleGit} from 'simple-git'
import {URL} from 'url'
import * as util from 'util'
import YAML from 'yaml'
import configSchema from '../config.schema.json'
import {Config} from './internal/config'
import {injectModifiableSections, ModifiableSections, parseModifiableSections} from './internal/modifiableSections'
import {newOctokitInstance} from './internal/octokit'

export type Repo = components['schemas']['full-repository']
export type PullRequest = components['schemas']['pull-request']
export type PullRequestSimple = components['schemas']['pull-request-simple']
export type NewPullRequest = operations['pulls/create']['requestBody']['content']['application/json']

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

require('debug').log = function log(...args) {
    return process.stdout.write(`${util.format(...args)}\n`)
}

if (process.env.RUNNER_DEBUG || process.env.ACTIONS_STEP_DEBUG) {
    require('debug').enable('simple-git,simple-git:*')
    process.env.DEBUG = [
        process.env.DEBUG || '',
        'simple-git',
        'simple-git:*'
    ].filter(it => it.length).join(',')
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

const configFilePath = core.getInput('configFile', {required: true})
const patchFilesPattern = core.getInput('patchFiles', {required: true})
const conventionalCommits = core.getInput('conventionalCommits', {required: true}).toLowerCase() === 'true'
const dryRun = core.getInput('dryRun', {required: true}).toLowerCase() === 'true'
const templateRepositoryFullName = core.getInput('templateRepository', {required: false})

const githubToken = core.getInput('githubToken', {required: true})
core.setSecret(githubToken)

const octokit = newOctokitInstance(githubToken)

const syncBranchName = getSyncBranchName()
const commitMessage = getCommitMessage()

const PULL_REQUEST_LABEL = 'sync-with-template'
const SYNCHRONIZATION_EMAIL_SUFFIX = '+sync-with-template@users.noreply.github.com'
const DEFAULT_GIT_ENV: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASK_YESNO: 'false',
}

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

async function run(): Promise<void> {
    try {
        const workspacePath = require('tmp').dirSync().name
        debug(`Workspace path: ${workspacePath}`)

        const repo = await octokit.repos.get({
            owner: context.repo.owner, repo:
            context.repo.repo
        }).then(it => it.data)
        core.info(`Using ${repo.full_name} as the current repository`)

        const defaultBranchName = repo.default_branch
        core.info(`Using '${defaultBranchName}' as a default branch of the current repository`)

        const templateRepo = await getTemplateRepo(repo)
        if (templateRepo == null) {
            core.warning("Template repository name can't be retrieved: the current repository isn't created from a"
                + " template and 'templateRepository' input isn't set")
            return
        }
        core.info(`Using ${templateRepo.full_name} as a template repository`)


        const git = simpleGit(workspacePath)
            .env(DEFAULT_GIT_ENV)

        await core.group("Initializing the repository", async () => {
            await git.init()
            await git.addConfig('gc.auto', '0')
            await git.addConfig('user.useConfigOnly', 'true')
            await git.addConfig('diff.algorithm', 'patience')
            //await git.addConfig('core.pager', 'cat')
            await git.addConfig('fetch.recurseSubmodules', 'yes')

            const basicCredentials = Buffer.from(`x-access-token:${githubToken}`, 'utf8').toString('base64')
            core.setSecret(basicCredentials)
            for (const origin of [new URL(repo.svn_url).origin, new URL(templateRepo.svn_url).origin]) {
                await git.addConfig(`http.${origin}/.extraheader`, `Authorization: basic ${basicCredentials}`)
            }

            const userName = repo.owner != null
                ? repo.owner.login
                : context.repo.owner
            await git.addConfig('user.name', userName)

            const userEmail = repo.owner != null
                ? `${repo.owner.id}+${repo.owner.login}${SYNCHRONIZATION_EMAIL_SUFFIX}`
                : `${context.repo.owner}${SYNCHRONIZATION_EMAIL_SUFFIX}`
            await git.addConfig('user.email', userEmail)

            debug(`Adding 'origin' remote: ${repo.svn_url}`)
            await git.addRemote('origin', repo.svn_url)
            await git.fetch('origin', repo.default_branch)

            debug(`Adding 'template' remote: ${templateRepo.svn_url}`)
            await git.addRemote('template', templateRepo.svn_url)
            await git.fetch('template', templateRepo.default_branch)
        })

        const originSha = await git.raw('rev-parse', `origin/${repo.default_branch}`).then(it => it.trim())
        const templateSha = await git.raw('rev-parse', `template/${repo.default_branch}`).then(it => it.trim())

        core.info(`Creating '${syncBranchName}' branch from ${repo.html_url}/tree/${originSha}`)
        await git.raw('checkout', '-f', '-B', syncBranchName, `remotes/origin/${repo.default_branch}`)

        const config = await core.group(`Parsing config: ${configFilePath}`, async () => {
            const configContent = fs.readFileSync(path.join(workspacePath, configFilePath), 'utf8')
            const parsedConfig = YAML.parse(configContent)
            delete parsedConfig.$schema

            const ajv = new Ajv2020()
            const validate = ajv.compile(configSchema)
            const valid = validate(parsedConfig)
            if (!valid) {
                throw new Error(`Config validation error: ${JSON.stringify(validate.errors, null, 2)}`)
            }

            return parsedConfig as unknown as Config
        })

        await core.group("Checkouting template files", async () => {
            const includesMatcher = config.includes != null && config.includes.length
                ? picomatch(config.includes)
                : undefined
            const excludesMatcher = config.excludes != null && config.excludes.length
                ? picomatch(config.excludes)
                : undefined
            const filesToSync = await git.raw(
                'ls-tree',
                '-r',
                '--name-only',
                `remotes/template/${templateRepo.default_branch}`
            )
                .then(content => content.split('\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0)
                )
                .then(allFiles => {
                    return allFiles
                        .filter(file => includesMatcher == null || includesMatcher(file))
                        .filter(file => excludesMatcher == null || !excludesMatcher(file))
                })

            for (const fileToSync of filesToSync) {
                core.info(`Checkouting '${fileToSync}': ${templateRepo.html_url}/blob/${templateSha}/${fileToSync}`)

                const fullFilePath = path.join(workspacePath, fileToSync)
                let sections: ModifiableSections | undefined = undefined
                if (await isTextFile(fullFilePath)) {
                    const content = fs.readFileSync(fullFilePath, 'utf-8')
                    sections = parseModifiableSections(content)
                }

                await git.raw('checkout', `template/${templateRepo.default_branch}`, '--', fileToSync)

                if (sections != null && Object.keys(sections).length) {
                    core.info(`  Processing modifiable sections: ${Object.keys(sections).join(', ')}`)
                    let content = fs.readFileSync(fullFilePath, 'utf-8')
                    content = injectModifiableSections(content, sections)
                    fs.writeFileSync(fullFilePath, content)
                }
            }
        })

        await core.group("Applying patches", async () => {
            const globber = await glob.create(path.join(workspacePath, patchFilesPattern))
            const patchFiles = await globber.glob()
            let arePatchesApplied = false
            for (const patchFile of patchFiles) {
                arePatchesApplied = true
                core.info(`Applying ${patchFile}: ${repo.html_url}/blob/${originSha}/${patchFile}`)
                const cmd: string[] = ['apply', '--ignore-whitespace', '--allow-empty']
                config.includes?.forEach(it => cmd.push(`--include=${it}`))
                config.excludes?.forEach(it => cmd.push(`--exclude=${it}`))
                await git.raw(cmd)
            }
            if (!arePatchesApplied) {
                core.info(`No patches found by glob '${patchFilesPattern}'`)
            }
        })

        await git.raw('add', '--all')
        const changedFiles = await git.status().then(response => response.files)

        await core.group("Changes", async () => {
            if (changedFiles.length === 0) {
                core.info('No files were changed')
                return
            }

            await git.raw('diff', '--cached').then(content => core.info(content))
        })

        await core.group("Committing and creating PR", async () => {
            const openedPr = await getOpenedPullRequest()

            if (changedFiles.length === 0) {
                core.info('No files were changed, nothing to commit')
                if (!dryRun) {
                    if (openedPr != null) {
                        await closePullRequest(
                            openedPr,
                            'autoclosed',
                            `Autoclosing the PR, as no files will be changed after merging the changes`
                            + ` from \`${syncBranchName}\` branch into \`${defaultBranchName}\` branch.`
                        )
                    }
                    const repoBranches = await getRemoteBranches(git, 'origin')
                    if (repoBranches.includes(syncBranchName)) {
                        core.info(`Removing '${syncBranchName}' branch, as no files will be changed after merging the changes`
                            + ` from '${syncBranchName}' branch into '${defaultBranchName}' branch`
                        )
                        await git.raw('push', ' --delete', 'origin', syncBranchName)
                    }
                }
                return
            }

            if (dryRun) {
                core.warning("Skipping Git push and PR creation, as dry run is enabled")
                return
            }

            await git.commit(commitMessage, {
                '--allow-empty': null,
            })

            await git.raw('push', '--force', 'origin', syncBranchName)

            if (openedPr == null) {
                let pullRequestTitle = `Merge template repository changes: ${templateRepo.full_name}`
                if (conventionalCommits) {
                    pullRequestTitle = `chore(template): ${pullRequestTitle}`
                }

                const newPullRequest = await createPullRequest({
                    head: syncBranchName,
                    base: defaultBranchName,
                    title: pullRequestTitle,
                    body: "Template repository changes."
                        + "\n\nIf you close this PR, it will be recreated automatically.",
                    maintainer_can_modify: true,
                })

                core.info(`Pull request for '${syncBranchName}' branch has been created: ${newPullRequest.html_url}`)
            }
        })

    } catch (error) {
        core.setFailed(error instanceof Error ? error : (error as object).toString())
    }
}

//noinspection JSIgnoredPromiseFromCall
run()

/* * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * */

function debug(message: string) {
    if (process.env.RUNNER_DEBUG || process.env.ACTIONS_STEP_DEBUG) {
        core.info(message)
    } else {
        core.debug(message)
    }
}

function getSyncBranchName(): string {
    const name = core.getInput('syncBranchName', {required: true})
    if (!conventionalCommits || name.toLowerCase().startsWith('chore/')) {
        return name
    } else {
        return `chore/${name}`
    }
}

function getCommitMessage(): string {
    const message = core.getInput('commitMessage', {required: true})
    if (!conventionalCommits || message.toLowerCase().startsWith('chore(')) {
        return message
    } else {
        return `chore(template): ${message}`
    }
}

async function getTemplateRepo(currentRepo: Repo): Promise<Repo | undefined> {
    const templateRepoName = templateRepositoryFullName
    if (templateRepoName === currentRepo.template_repository?.full_name) {
        return currentRepo.template_repository as any as Repo

    } else if (!templateRepoName) {
        if (currentRepo.template_repository != null) {
            return currentRepo.template_repository as any as Repo
        }

    } else {
        const [owner, repo] = templateRepoName.split('/')
        return octokit.repos.get({owner, repo}).then(it => it.data)
    }

    return undefined
}

async function isTextFile(filePath: fs.PathLike): Promise<boolean> {
    if (!fs.existsSync(filePath)) {
        return false
    }

    const bytes = fs.readFileSync(filePath)
    for (const pair of bytes.entries()) {
        if (pair[1] === 0) {
            return false
        }
    }
    return true
}

async function getRemoteBranches(git: SimpleGit, remoteName: string): Promise<string[]> {
    const branchPrefix = `refs/heads/`
    return git.listRemote(['--exit-code', '--refs', '--heads', '--quiet', remoteName]).then(content => {
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
}

async function getOpenedPullRequest(): Promise<PullRequestSimple | undefined> {
    return octokit.paginate(octokit.pulls.list, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        state: 'open',
        head: `${context.repo.owner}:${syncBranchName}`,
        sort: 'created',
        direction: 'desc',
    })
        .then(prs => prs.filter(pr => pr.head.ref === syncBranchName))
        .then(prs => {
            const promises = prs.map((pr, index) =>
                index === 0
                    ? Promise.resolve(pr)
                    : closePullRequest(pr, 'autoclosed redundant')
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

async function closePullRequest(
    pullRequest: PullRequest | PullRequestSimple,
    titleSuffix?: string,
    message?: string
) {
    core.info(`Closing pull request ${pullRequest.html_url}`)

    if (message) {
        await octokit.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: pullRequest.number,
            body: message
        })
    }

    return octokit.pulls.update({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pullRequest.number,
        state: 'closed',
        title: titleSuffix
            ? `${pullRequest.title} - ${titleSuffix}`
            : pullRequest.title
    }).then(it => it.data)
}

async function createPullRequest(info: NewPullRequest) {
    const pullRequest = await octokit.pulls.create(Object.assign(
        {
            owner: context.repo.owner,
            repo: context.repo.repo,
        },
        info
    )).then(it => it.data)

    await octokit.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: pullRequest.number,
        labels: [PULL_REQUEST_LABEL],
    })

    return pullRequest
}
