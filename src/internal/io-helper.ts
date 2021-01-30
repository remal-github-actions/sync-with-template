import * as fs from 'fs'
import path from 'path'

export function getWorkspacePath(): string {
    let githubWorkspacePath = process.env['GITHUB_WORKSPACE']
    if (!githubWorkspacePath) {
        throw new Error('GITHUB_WORKSPACE not defined')
    }
    githubWorkspacePath = path.resolve(githubWorkspacePath)
    return githubWorkspacePath
}

export function createDirectory(dirPath: string): string {
    let stats: fs.Stats | null = null
    try {
        stats = fs.statSync(dirPath)
    } catch (error) {
        if (error.code === 'ENOENT') {
            // doesn't exist, do nothing
        } else {
            throw new Error(
                `Encountered an error when checking whether path '${dirPath}' exists: ${error.message}`
            )
        }
    }

    if (stats != null) {
        if (stats.isDirectory()) {
            return dirPath
        } else {
            throw new Error(
                `Encountered an error when creating directory '${dirPath}': file already exists, and it's not a directory`
            )
        }
    }

    fs.mkdirSync(dirPath, {recursive: true})

    return dirPath
}

export function ensureEmptyDirectory(dirPath: string): string {
    createDirectory(dirPath)
    const isEmpty = fs.readdirSync(dirPath).length === 0
    if (!isEmpty) {
        throw new Error(
            `Directory isn't empty: '${dirPath}'`
        )
    }
    return dirPath
}
