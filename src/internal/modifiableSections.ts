const MODIFIABLE_SECTION_PREFIX = /.*\$\$\$sync-with-template-modifiable:\s*([^$]+?)\s*\$\$\$.*/
const MODIFIABLE_SECTION_END = /.*\$\$\$sync-with-template-modifiable-end\$\$\$.*/

export type ModifiableSections = Record<string, string[]>

export function parseModifiableSections(content: string): ModifiableSections {
    const sections: ModifiableSections = {}
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; ++index) {
        const line = lines[index]
        const section = line.replace(MODIFIABLE_SECTION_PREFIX, '$1')
        if (section === line) {
            continue
        }

        if (sections[section] != null) {
            throw new Error(`Multiple modifiable sections ${section}`)
        }

        const sectionLines: string[] = []
        ++index
        for (; index < lines.length; ++index) {
            const nextLine = lines[index]
            if (nextLine.match(MODIFIABLE_SECTION_END)) {
                break
            } else {
                sectionLines.push(nextLine)
            }
        }

        sections[section] = sectionLines
    }
    return sections
}

export function injectModifiableSections(content: string, sections: ModifiableSections): string {
    const newLines: string[] = []
    const lines = content.split('\n')
    for (let index = 0; index < lines.length; ++index) {
        const line = lines[index]
        newLines.push(line)

        const section = line.replace(MODIFIABLE_SECTION_PREFIX, '$1')
        if (section === line) {
            continue
        }

        const sectionLines = sections[section]
        if (sectionLines == null) {
            continue
        }

        newLines.push(...sectionLines)

        ++index
        for (; index < lines.length; ++index) {
            const nextLine = lines[index]
            if (nextLine.match(MODIFIABLE_SECTION_END)) {
                newLines.push(nextLine)
                break
            }
        }
    }
    return newLines.join('\n')
}
