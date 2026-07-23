<template>
  <main id="app">
    <h1>用户管理</h1>
    <CreateUserId />
  </main>
</template>

<script>
import CreateUserId from "./views/createuserid.vue"

export default {
  name: "App",
  components: {
    CreateUserId
  }
}
</script>
