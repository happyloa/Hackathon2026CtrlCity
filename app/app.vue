<script setup lang="ts">
const socialImage = '/og.png'

useSeoMeta({
  title: 'YouBike 調度雷達',
  description: '新北市公共自行車營運調度數據視覺化及預測模型',
  ogTitle: 'YouBike 調度雷達',
  ogDescription: '先看見，再派車。以歷史資料預判站點庫存失衡。',
  ogImage: socialImage,
  ogImageAlt: 'YouBike 調度雷達戰情室',
  twitterCard: 'summary_large_image',
  twitterTitle: 'YouBike 調度雷達',
  twitterDescription: '先看見，再派車。',
  twitterImage: socialImage,
})
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
