import * as core from '@actions/core'
import { context } from '@actions/github'
import { calculateHash } from './calculateHash.js'

export function adjustGitHubActionsCron(content: string): string {
    return content.toString().replaceAll(
        /(\s+schedule:[\r\n]+\s+-\s+cron:\s+)(['"]?)([^'"]+)\2(\s*#\s*sync-with-template\s*:\s*adjust)\b/g,
        (match, prefix, quote, expression, suffix) => {
            const tokens = expression.trim().split(/\s+/)
            if (tokens.length !== 5) return match

            const hash = Math.abs(calculateHash(`${context.repo.owner}/${context.repo.repo}`)) || 2398461
            processCronTokens(tokens, hash)

            const newExpression = tokens.join(' ')
            core.info(`    Adjusting cron expression from '${expression}' to '${newExpression}'`)

            quote = quote || ''
            return prefix + quote + newExpression + quote + suffix
        },
    )
}

function processCronTokens(tokens: string[], hash: number) {
    for (let i = 0; i < tokens.length; ++i) {
        tokens[i] = processCronToken(i, tokens[i], hash)
    }
}

function processCronToken(tokenIndex: number, token: string, hash: number): string {
    const maxValue = [60, 24, 31, 12, 7][tokenIndex]
    if (maxValue == null) {
        return token
    }

    return token.split(/,/)
        .filter(it => !!it.length)
        .map(it => processCronTokenPart(it, hash, maxValue))
        .join(',')
}

export function processCronTokenPart(tokenPart: string, hash: number, maxValue: number): string {
    if (tokenPart === '*') {
        return tokenPart
    }

    if (tokenPart.match(/^\d+$/)) {
        const num = parseInt(tokenPart, 10)
        const resultNum = (num + hash) % maxValue
        return `${resultNum}`
    }

    {
        const match = tokenPart.match(/^(\d+)-(\d+)$/)
        if (match != null) {
            for (let n = 0; ; ++n) {
                const min = (parseInt(match[1], 10) + hash + n) % maxValue
                const max = (parseInt(match[2], 10) + hash + n) % maxValue
                if (max <= min) {
                    continue
                }
                return `${min}-${max}`
            }
        }
    }

    {
        const match = tokenPart.match(/^(\*|\d+)\/(\d+)$/)
        if (match != null) {
            const every = parseInt(match[2], 10)
            const start = ((match[1] === '*' ? 0 : parseInt(match[1], 10)) + hash) % Math.min(every, maxValue)
            return `${start}/${every}`
        }
    }

    return tokenPart
}
