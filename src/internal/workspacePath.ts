import path from "path"

let workspacePath: string = process.env['GITHUB_WORKSPACE'] || ''
if (!workspacePath) {
    throw new Error('GITHUB_WORKSPACE not defined')
}
workspacePath = path.resolve(workspacePath)

export = workspacePath
