export function evalInScope(js: string, context: Record<string, any>) {
    return new Function(`with (this) { ${js} }`).call(context)
}
