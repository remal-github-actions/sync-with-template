import fs from 'fs'

export function isTextFile(filePath: fs.PathLike): boolean {
    if (!fs.existsSync(filePath)) {
        return false
    }

    const fd = fs.openSync(filePath, 'r')
    try {
        const buffer = Buffer.alloc(1)
        const readBytes = fs.readSync(fd, buffer, 0, 1, null)
        if (readBytes === 0) {
            return false
        }

        const firstByte = buffer[0]
        if (firstByte === 0) {
            return false
        }

        return true

    } finally {
        fs.closeSync(fd)
    }
}
