// app.js
// 宝哥工作台 · 全局入口
// 设计原则：
//   1) 本地存储优先 —— 不开云开发也能用全部功能
//   2) 云同步可选 —— 在「我的」页打开开关后写入云数据库
//   3) 全局只需一份配置：所有页面通过 getApp() 拿到共享参数

App({
  globalData: {
    // 书脊配色候选池（建书时自动轮换分配）
    bookColors: [
      '#378ADD', '#1D9E75', '#D85A30', '#534AB7',
      '#D4537E', '#BA7517', '#E24B4A', '#0F6E56',
      '#185FA5', '#993556', '#3B6D11', '#0F6E56'
    ],
    // 待办来源标记
    sourceLabels: {
      manual:   { label: '手动',   color: '#888780', icon: '○' },
      reading:  { label: '读书',   color: '#185FA5', icon: '📖' },
      learning: { label: '学习',   color: '#0F6E56', icon: '🎯' },
      fitness:  { label: '健身',   color: '#854F0B', icon: '🏋' }
    },
    cloudSync: false,
    cloudEnv: 'baoge-default',
    themeDark: false
  },

  onLaunch() {
    // 读取本地设置，决定是否初始化云开发
    const settings = wx.getStorageSync('baoge:settings') || {};
    if (settings.cloudSync && wx.cloud) {
      this.globalData.cloudSync = true;
      try {
        wx.cloud.init({
          env: settings.cloudEnv || this.globalData.cloudEnv,
          traceUser: true
        });
        console.log('[baoge] cloud init ok, env:', settings.cloudEnv);
      } catch (e) {
        console.warn('[baoge] cloud init failed, fall back to local only', e);
        this.globalData.cloudSync = false;
      }
    }

    // 暗色模式：从设置读取
    this.globalData.themeDark = !!settings.dark;

    // 输出当前模式，便于调试
    console.log('[baoge] running in',
      this.globalData.cloudSync ? 'cloud-sync mode' : 'local-only mode');
  },

  // 应用主题到某个页面（设置根容器 class + 原生导航栏/背景）
  applyTheme(page) {
    const dark = !!this.globalData.themeDark;
    if (page && page.setData) {
      page.setData({ themeDark: dark ? 'theme-dark' : '' });
    }
    if (typeof wx.setBackgroundColor === 'function') {
      const bg = dark ? '#16161a' : '#f7f5ee';
      wx.setBackgroundColor({
        backgroundColor: bg,
        backgroundColorTop: bg,
        backgroundColorBottom: bg
      });
    }
    if (typeof wx.setNavigationBarColor === 'function') {
      wx.setNavigationBarColor({
        frontColor: dark ? '#ffffff' : '#000000',
        backgroundColor: dark ? '#16161a' : '#f7f5ee'
      });
    }
  }
});