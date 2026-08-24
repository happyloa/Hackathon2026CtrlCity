<script setup lang="ts">
const socialImage = '/og.png'

useSeoMeta({
  title: '新北市 YouBike 調度工作台',
  description: '新北市公共自行車站點庫存、風險與調度決策支援',
  ogTitle: '新北市 YouBike 調度工作台',
  ogDescription: '以即時站況、歷史基線與多站路線規劃協助檢視庫存風險。',
  ogImage: socialImage,
  ogImageAlt: '新北市 YouBike 調度工作台',
  twitterCard: 'summary_large_image',
  twitterTitle: '新北市 YouBike 調度工作台',
  twitterDescription: '新北市站點庫存與調度決策支援。',
  twitterImage: socialImage,
})
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
