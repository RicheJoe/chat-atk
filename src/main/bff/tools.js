import { tool } from '@langchain/core/tools'
import { z } from 'zod'

const CLASS_SOURCE = {
  updated: '2026-09-23',
  sourceTitle: '区分表中的五个常见类',
  source:
    'https://sbj.cnipa.gov.cn/res/shangbiaoju/static/sbj/tem/202609/%E7%B1%BB%E4%BC%BC%E5%95%86%E5%93%81%E5%92%8C%E6%9C%8D%E5%8A%A1%E5%8C%BA%E5%88%86%E8%A1%A8--%E5%9F%BA%E4%BA%8E%E5%B0%BC%E6%96%AF%E5%88%86%E7%B1%BB%E7%AC%AC%E5%8D%81%E4%BA%8C%E7%89%88%EF%BC%882025%E6%96%87%E6%9C%AC%EF%BC%89.pdf'
}

const CLASSES = [
  {
    classNo: 9,
    title: '第九类',
    heading: '计算机、软件和仪器',
    patterns: [/软件/, /计算机/, /电脑/, /app/i, /智能手表/, /眼镜/],
    ask: '追问具体项目，例如已录制的计算机软件或可下载的计算机应用软件。不要把第九类标题当作申报名称。'
  },
  {
    classNo: 25,
    title: '第二十五类',
    heading: '服装、鞋、帽',
    patterns: [/衣服/, /服装/, /鞋/, /帽/],
    block: [/手套/, /头盔/, /手术衣/],
    ask: '申报时填具体项目。家务手套、医用手套、防事故手套不在这一类。'
  },
  {
    classNo: 30,
    title: '第三十类',
    heading: '咖啡、茶、米面和调味品',
    patterns: [
      /咖啡/,
      /茶/,
      /可可/,
      /米面/,
      /面条/,
      /面粉/,
      /面包/,
      /糕点/,
      /巧克力/,
      /冰淇淋/,
      /调味/,
      /酱油/,
      /醋/
    ],
    ask: '加奶咖啡饮料在第三十类；以牛奶为主的牛奶饮料在第二十九类，不在本工具覆盖范围内。申报填具体项目。'
  },
  {
    classNo: 35,
    title: '第三十五类',
    heading: '广告和商业管理',
    patterns: [/广告/, /推销/, /网店/, /卖货/, /人事/, /会计/, /商业管理/, /饭店管理/],
    ask: '追问是广告、推销、人事还是会计。饭店商业管理在第三十五类，不等于提供餐饮。'
  },
  {
    classNo: 43,
    title: '第四十三类',
    heading: '餐饮和临时住宿',
    patterns: [/餐馆/, /餐厅/, /咖啡馆/, /饭店/, /旅馆/, /住宿/, /餐饮/],
    ask: '只说饭店管理、不提供餐饮时，商业管理在第三十五类。申报填具体项目。'
  }
]

const MATERIAL_SOURCE = {
  updated: '2026-09-23',
  sourceTitle: '商标注册申请常见问题',
  source: 'https://sbj.cnipa.gov.cn/cjwt/2026/0829/20096.html',
  pageNote: '页面发布时间 2023-03-31，文末写内容于 2022 年 1 月发布。'
}

const MATERIALS = {
  国内自然人: {
    items: [
      '申请人签字的《商标注册申请书》',
      '商标图样',
      '个体工商户营业执照复印件',
      '身份证明文件复印件'
    ],
    notes: ['同一申请人同时办理多件申请时，身份证复印件和个体工商户营业执照复印件各提供一份即可。']
  },
  国内法人: {
    items: [
      '加盖申请人公章的《商标注册申请书》',
      '商标图样',
      '标注统一社会信用代码的身份证明文件复印件'
    ],
    notes: ['企业一般提交营业执照。期刊证、办学许可证、卫生许可证不能作为身份证明文件。']
  },
  其他组织: {
    items: [
      '加盖申请人公章的《商标注册申请书》',
      '商标图样',
      '标注统一社会信用代码的身份证明文件复印件'
    ],
    notes: [
      '非企业可以提交事业单位法人证书、社会团体法人登记证书、民办非企业单位登记证书、基金会法人登记证书、律师事务所执业许可证等。',
      '代表处、办事处不能以自己的名义申请商标注册。'
    ]
  },
  农村承包经营户: {
    items: ['承包合同复印件'],
    notes: ['可以以承包合同签约人的名义申请，商品和服务范围以自营的农副产品为限。']
  }
}

const FEE_SOURCE = {
  updated: '2026-09-23',
  sourceTitle: '分类、材料和费用',
  source: 'https://sbj.cnipa.gov.cn/zcwj/2026/0829/40039.html',
  basis: '《商标法》（2026年修正）第八十六条。自 2027-01-01 起施行。收费标准另定。'
}

export const TOOL_LABELS = {
  suggest_class: '候选类别',
  list_materials: '材料清单',
  estimate_fee: '费用'
}

function hitClass(item, text) {
  if (item.block?.some((pattern) => pattern.test(text))) return false
  return item.patterns.some((pattern) => pattern.test(text))
}

function suggestClass({ description }) {
  const text = String(description ?? '').trim()
  if (!text) {
    return {
      ...CLASS_SOURCE,
      covered: false,
      candidates: [],
      message: '需要商品或服务描述后才能给出候选类别。'
    }
  }
  if (/食品/.test(text) && !CLASSES[2].patterns.some((pattern) => pattern.test(text))) {
    return {
      ...CLASS_SOURCE,
      covered: true,
      needClarify: true,
      candidates: [],
      message:
        '只说卖食品时，先问是饮料、米面、调味品还是乳制品，不能直接报第三十类。乳制品不在当前五类里。'
    }
  }

  let matched = CLASSES.filter((item) => hitClass(item, text))
  if (/饭店管理|商业管理/.test(text) && !/餐馆|餐厅|咖啡馆|餐饮|吃饭/.test(text)) {
    matched = matched.filter((item) => item.classNo !== 43)
  }
  if (/手套/.test(text) && !/衣服|服装|鞋|帽/.test(text)) {
    matched = matched.filter((item) => item.classNo !== 25)
  }

  if (!matched.length) {
    return {
      ...CLASS_SOURCE,
      covered: false,
      candidates: [],
      message:
        '当前只覆盖第九、二十五、三十、三十五、四十三类。这句话没有对上这五类，不要编其他类别，也不能判断能否注册。'
    }
  }

  return {
    ...CLASS_SOURCE,
    covered: true,
    needClarify: false,
    candidates: matched.map((item) => ({
      classNo: item.classNo,
      title: item.title,
      heading: item.heading,
      ask: item.ask
    })),
    message:
      '候选类别不是审查结论。申报填写具体项目，不要填写类别标题。不能判断能否注册、是否近似或是否侵权。'
  }
}

function normalizeApplicant(value) {
  const text = String(value ?? '').trim()
  if (/承包|农户/.test(text)) return '农村承包经营户'
  if (/自然人|个体/.test(text)) return '国内自然人'
  if (/法人|公司|企业/.test(text)) return '国内法人'
  if (/其他组织|事业单位|社会团体|民办非企业|基金会|律师事务所/.test(text)) return '其他组织'
  if (MATERIALS[text]) return text
  return ''
}

function listMaterials({ applicantType }) {
  const type = normalizeApplicant(applicantType)
  if (!type) {
    return {
      ...MATERIAL_SOURCE,
      known: false,
      applicantType: String(applicantType ?? ''),
      items: [],
      message: '先确认申请人是国内自然人、国内法人、其他组织，还是农村承包经营户。不要编材料。'
    }
  }
  const record = MATERIALS[type]
  return {
    ...MATERIAL_SOURCE,
    known: true,
    applicantType: type,
    items: record.items,
    notes: record.notes,
    message: '清单只包括该页写明的材料。执照注销、执照没有字号时如何填写，本页没有。'
  }
}

function estimateFee({ classCount }) {
  const count = Number(classCount)
  const valid = Number.isInteger(count) && count > 0
  return {
    ...FEE_SOURCE,
    recorded: false,
    classCount: valid ? count : null,
    amount: null,
    message: valid
      ? `已记下 ${count} 个类别，但摘录页面没有一类多少钱，也没有超出项目如何加收。不能推算金额，回答未收录。`
      : '还没有有效的类别数。即便有类别数，当前摘录也没有金额，不能报数。'
  }
}

export const trademarkTools = [
  tool(async (input) => JSON.stringify(suggestClass(input)), {
    name: 'suggest_class',
    description:
      '根据商品或服务描述，在第九、二十五、三十、三十五、四十三类里给出候选类别。不能判断能否注册。描述不清楚时会要求追问。',
    schema: z.object({
      description: z.string().describe('用户说的商品或服务，例如卖衣服、做软件、开餐馆')
    })
  }),
  tool(async (input) => JSON.stringify(listMaterials(input)), {
    name: 'list_materials',
    description:
      '按申请人类型返回商标注册申请材料清单。类型不清楚时不要猜测，工具会要求先问清类型。',
    schema: z.object({
      applicantType: z
        .string()
        .describe(
          '国内自然人、个体户、国内法人、公司、其他组织或农村承包经营户。不清楚就原样填写用户的说法'
        )
    })
  }),
  tool(async (input) => JSON.stringify(estimateFee(input)), {
    name: 'estimate_fee',
    description:
      '按类别数查询官费。当前知识库没有收费金额，工具不会返回数字。用户问多少钱时必须调用，禁止自己心算。',
    schema: z.object({
      classCount: z.coerce.number().describe('要注册的类别数量。用户没说就填 0')
    })
  })
]

export const toolGuide = {
  role: 'system',
  content: [
    '需要候选类别、申请材料或官费时调用工具，不要凭记忆编造。',
    'suggest_class 只覆盖第九、二十五、三十、三十五、四十三类。',
    'estimate_fee 的 recorded 为 false 时，回答未收录，禁止写出任何金额。',
    '把工具返回组织成中文，并带上其中的更新日期和来源标题。'
  ].join('\n')
}
