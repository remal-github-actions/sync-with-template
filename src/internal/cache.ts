export interface CachePropertyDescriptor<T, R> extends PropertyDescriptor {
    get?: (this: T) => R;
}

export function cache<T, R>(target: any, name: PropertyKey, descriptor: CachePropertyDescriptor<T, R>) {
    const getter = descriptor.get
    if (!getter || descriptor.set || descriptor.value) {
        throw new TypeError(`Property getter is expected: ${name.toString()}`)
    }

    const promiseHolder = new PromiseHolder()
    descriptor.get = function () {
        const value = getter.call(this)

        if (value instanceof Promise) {
            const promise = (value as Promise<unknown>)
                .then(result => promiseHolder.resolve(result))
                .catch(reason => promiseHolder.reject(reason))

            Object.defineProperty(this, name, {
                configurable: descriptor.configurable,
                enumerable: descriptor.enumerable,
                get() {
                    if (promiseHolder.isResolved) {
                        if (promiseHolder.error !== undefined) {
                            return Promise.reject(promiseHolder.error)
                        } else {
                            return Promise.resolve(promiseHolder.value)
                        }

                    } else {
                        return promise
                    }
                }
            })

        } else {
            Object.defineProperty(this, name, {
                configurable: descriptor.configurable,
                enumerable: descriptor.enumerable,
                writable: false,
                value
            })
        }

        return value
    }
}


class PromiseHolder {

    isResolved: boolean = false

    value?: unknown

    resolve(value: unknown): unknown {
        this.isResolved = true
        this.value = value
        return value
    }

    error: unknown = undefined

    reject(error: unknown): unknown {
        this.isResolved = true
        this.error = error
        return error
    }

}
