import path from 'path'

let workspacePath: string = process.env['GITHUB_WORKSPACE'] || process.cwd()
workspacePath = path.resolve(workspacePath)

export = workspacePath
