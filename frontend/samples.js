// 两份完整演示数据：操作页做挂号流程，文章页做政务通知阅读与理解。
window.EASYVIEW_SAMPLES = {
  hospital: {
    pageType: "operation",
    title: "市第一人民医院",
    subtitle: "您好，请按提示完成预约挂号",
    intro: "我会带您一步步完成挂号，每一步都会给出语音提示。",
    flow: {
      steps: [
        {
          id: "dept",
          title: "选择科室",
          prompt: "请选择您要挂号的科室",
          description: "如果不确定，可以直接告诉助手您的症状。",
          options: [
            { label: "内科", value: "内科" },
            { label: "外科", value: "外科" },
            { label: "儿科", value: "儿科" },
            { label: "耳鼻喉科", value: "耳鼻喉科" }
          ]
        },
        {
          id: "symptom",
          title: "选择症状",
          prompt: "请选择您的主要症状",
          description: "症状仅用于帮助医生了解情况，不会上传。",
          options: [
            { label: "发热", value: "发热" },
            { label: "咳嗽", value: "咳嗽" },
            { label: "头晕", value: "头晕" },
            { label: "腹痛", value: "腹痛" }
          ]
        },
        {
          id: "doctor",
          title: "选择医生",
          prompt: "请选择接诊医生",
          description: "建议选择有号源的医生。",
          options: [
            { label: "王医生（主任医师）", value: "王医生" },
            { label: "李医生（副主任医师）", value: "李医生" },
            { label: "张医生（主治医师）", value: "张医生" }
          ]
        },
        {
          id: "time",
          title: "选择就诊时间",
          prompt: "请选择就诊时间",
          description: "请合理安排到院时间。",
          options: [
            { label: "今天 10:30", value: "今天 10:30" },
            { label: "今天 14:00", value: "今天 14:00" },
            { label: "明天 09:00", value: "明天 09:00" }
          ]
        },
        {
          id: "confirm",
          title: "确认预约",
          prompt: "请确认以下预约信息",
          description: "确认后将生成挂号单。",
          isFinal: true
        }
      ]
    }
  },
  gov: {
    pageType: "article",
    title: "关于2026年度城乡居民基本医疗保险参保缴费的通知",
    subtitle: "请阅读正文，也可以点击下方智能助手，让它帮您理解重点。",
    source: "市医疗保障局",
    publishedAt: "2026年10月1日",
    summary: "通知明确，2026年度居民医保集中缴费期为2026年10月1日至12月31日，个人缴费标准为每人每年380元。",
    content: [
      { type: "heading", text: "一、参保对象" },
      { type: "paragraph", text: "本市未参加职工基本医疗保险的城乡居民，以及全日制在校学生，均属于参保范围。" },
      { type: "heading", text: "二、缴费时间" },
      { type: "paragraph", text: "集中缴费期为2026年10月1日至2026年12月31日。逾期未缴费的，将影响2027年度医保待遇享受。" },
      { type: "heading", text: "三、缴费标准" },
      { type: "paragraph", text: "2026年度个人缴费标准为每人每年380元，财政补助标准为每人每年670元。" },
      { type: "heading", text: "四、办理方式" },
      { type: "paragraph", text: "参保人可通过“XX市医保”微信小程序、各街道便民服务中心或社区医保服务站办理。线上缴费支持微信、支付宝和银行卡支付。" },
      { type: "heading", text: "五、所需材料" },
      { type: "paragraph", text: "首次参保人员请携带本人身份证、户口簿，到户籍所在地社区医保服务站登记。续保人员无需重复登记，可直接线上缴费。" },
      { type: "heading", text: "六、咨询电话" },
      { type: "paragraph", text: "如有疑问，可拨打医保服务热线 12393，服务时间为工作日 8:30-17:30。" }
    ],
    keyPoints: [
      "缴费期：2026年10月1日至12月31日",
      "个人缴费：380元/年",
      "首次参保需带身份证和户口簿",
      "服务热线：12393"
    ]
  }
};
