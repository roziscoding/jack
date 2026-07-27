---
aside: false
outline: false
---

<script setup lang="ts">
import { useRoute } from 'vitepress'
import spec from '../../public/openapi/peer.json'

const route = useRoute()

const operationId = route.data.params.operationId
</script>

<OAOperation :spec="spec" :operationId="operationId" />
