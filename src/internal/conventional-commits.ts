import conventionalCommitsDetector from 'conventional-commits-detector'

export function isConventionalCommit(commitMessage: string): boolean {
    const type = conventionalCommitsDetector([commitMessage])
    return type.length > 0 && type !== 'unknown'
}
