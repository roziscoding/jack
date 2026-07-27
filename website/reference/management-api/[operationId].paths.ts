import { usePaths } from 'vitepress-openapi'
import spec from '../../public/openapi/management.json' with { type: 'json' }

export default {
  paths() {
    return usePaths({ spec })
      .getPathsByVerbs()
      .map(({ operationId, summary }) => ({
        params: {
          operationId,
          pageTitle: `${summary} - jack management API`,
        },
      }))
  },
}
