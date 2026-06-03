import { logger } from '../../logger'
import { AppError } from '../errors/AppError'

/**
 * Method decorators that guard role-specific connector methods. A single arr
 * connector can act as a source, a destination, or both depending on its config
 * flags; these mirror `@requireInitialization` and throw when a method is called
 * on a connector that isn't configured for that role.
 *
 * Apply to methods on classes exposing `canSource` / `canDestination`.
 */

// These wrap async connector methods, so they are async too: a failed guard
// becomes a rejected promise (not a synchronous throw), matching how callers
// `await` these methods and how `@requireInitialization` behaves.
export function requiresSource(
  target: (...args: any[]) => any,
  _context: ClassMethodDecoratorContext,
) {
  return async function (this: any, ...args: any[]) {
    if (!this.canSource) {
      logger.warn({ connector: this.name }, `Blocked call: server "${this.name}" is not configured as a source`)
      throw new AppError(`Server "${this.name}" is not configured as a source`, 'NOT_A_SOURCE')
    }
    return target.apply(this, args)
  }
}

export function requiresDestination(
  target: (...args: any[]) => any,
  _context: ClassMethodDecoratorContext,
) {
  return async function (this: any, ...args: any[]) {
    if (!this.canDestination) {
      throw new AppError(`Server "${this.name}" is not configured as a destination`, 'NOT_A_DESTINATION')
    }
    return target.apply(this, args)
  }
}
