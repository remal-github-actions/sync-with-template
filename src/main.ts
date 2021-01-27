import * as core from '@actions/core'
import {newOctokitInstance} from "./internal/octokit"
import {context} from "@actions/github"

async function run(): Promise<void> {
    try {
        const pushToken: string = core.getInput('pushToken', {required: true})
        const octokit = newOctokitInstance(pushToken)
        const repo = await octokit.repos.get({
            owner: context.repo.owner,
            repo: context.repo.repo
        })
        core.warning(JSON.stringify(repo))
    } catch (error) {
        core.setFailed(error)
    }
}

run()
