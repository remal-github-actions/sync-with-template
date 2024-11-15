import fs from 'fs'

export function isTextFile(filePath: fs.PathLike): boolean {
    if (!fs.existsSync(filePath)) {
        return false
    }

    const fd = fs.openSync(filePath, 'r')
    try {
        const buffer = Buffer.alloc(100)
        const readBytes = fs.readSync(fd, buffer, 0, buffer.length, null)
        if (readBytes === 0) {
            return false
        }

        for (let i = 0; i < readBytes; ++i) {
            const byte = buffer[i]
            if (byte === 0) {
                return false
            }
        }

        return true

    } finally {
        fs.closeSync(fd)
    }
}
