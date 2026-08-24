<script setup lang="ts">
const socialImage = '/og.png'

useSeoMeta({
  title: '新北市 YouBike 營運工作台',
  description: '掌握即時站況、未來風險與多站搬運路線',
  ogTitle: '新北市 YouBike 營運工作台',
  ogDescription: '掌握即時站況、未來風險與多站搬運路線。',
  ogImage: socialImage,
  ogImageAlt: '新北市 YouBike 營運工作台',
  twitterCard: 'summary_large_image',
  twitterTitle: '新北市 YouBike 營運工作台',
  twitterDescription: '即時站況、未來風險與搬運路線。',
  twitterImage: socialImage,
})
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
