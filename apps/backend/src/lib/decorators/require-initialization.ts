/**
 * Method decorator that ensures the class instance is initialized before the method is invoked.
 *
 * Calls `init()` if the instance is not yet initialized, then awaits `isInitialized` before
 * proceeding. Can only be applied to methods on classes that expose both `isInitialized` and
 * `init`.
 *
 * @throws {TypeError} If the decorated method's class does not implement `isInitialized` and `init`.
 *
 * @example
 * class MyConnector extends DestinationServerConnector {
 *   @requireInitialization
 *   async fetchData() { ... }
 * }
 */
export function requireInitialization(
  target: (...args: any[]) => any,
  _context: ClassMethodDecoratorContext,
) {
  return async function (this: any, ...args: any[]) {
    if (!('isInitialized' in this) || !('init' in this)) {
      throw new TypeError(`@requireInitialization can only be used on classes that extend Initializable`)
    }

    const connector = this as any
    if (!connector.isInitialized) {
      connector.init()
    }
    await connector.isInitialized
    return target.apply(this, args)
  }
}
