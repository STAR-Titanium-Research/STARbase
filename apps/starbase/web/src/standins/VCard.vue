<template><div class="v-card"><slot /></div></template>
<style scoped>
.v-card { border-radius: calc(var(--theme--border-radius, 8px) + 4px); background: var(--theme--background); color: var(--theme--foreground); box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25); }
</style>
