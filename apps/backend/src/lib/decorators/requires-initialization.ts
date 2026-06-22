import { logger } from '../../logger'

/**
 * Method decorator that ensures the class instance is initialized before the method is invoked.
 *
 * Calls `init()` if the instance is not yet initialized, then awaits the
 * `initialization` promise before proceeding. Can only be applied to methods on
 * classes that expose `isInitialized`, `init` and `initialization`.
 *
 * @throws {TypeError} If the decorated method's class does not implement `isInitialized` and `init`.
 *
 * @example
 * class MyConnector extends ArrServerConnector {
 *   @requiresInitialization
 *   async fetchData() { ... }
 * }
 */
export function requiresInitialization(
  target: (...args: any[]) => any,
  context: ClassMethodDecoratorContext,
) {
  return async function (this: any, ...args: any[]) {
    if (!('isInitialized' in this) || !('init' in this)) {
      throw new TypeError(`@requireInitialization can only be used on classes that extend Initializable`)
    }

    const connector = this as any
    if (!connector.isInitialized) {
      logger.debug({ connector: connector.name, method: String(context.name) }, 'Connector not initialized yet; triggering init before call')
      connector.init()
    }
    // Await the initialization PROMISE, not the `isInitialized` boolean — awaiting
    // a boolean resolves immediately and lets the call run before init finishes.
    await connector.initialization
    return target.apply(this, args)
  }
}
