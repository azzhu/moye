// Appearance preferences are independent of document content and reading geometry.
export const APPEARANCE_STORAGE_KEY = 'inkwell.appearance.v1';
const sans = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const serif = '"Iowan Old Style","Palatino Linotype","Songti SC","Noto Serif CJK SC","SimSun",serif';
const baseAppearance = {
  bg: '#f7f8fb', surface: '#ffffff', sidebar: '#fbfbfd', line: '#e9eaf0', text: '#292c37',
  muted: '#9699a6', subtle: '#6d7282', purple: '#6960d9', 'purple-strong': '#6257da',
  'purple-wash': '#efedfd', hover: '#f2f2f7', 'code-bg': '#fafbfe', paper: '#ffffff',
  'reading-text': '#30343b', 'quote-bg': '#f7f5fc', 'quote-text': '#555061',
  'code-text': '#414658', 'button-radius': '6px', 'card-radius': '9px',
  shadow: '0 3px 18px #25264104', 'reading-font': sans, 'interface-font': sans,
};
const appearance = (id, name, description, badge, tokens, dark = false) => ({
  id, name, description, badge, dark, tokens: { ...baseAppearance, ...tokens },
});
export const READING_STYLES = [
  appearance('default', '默认', '熟悉的紫色点缀，保留当前界面', '经典', {}),
  appearance('light', '浅色模式', '纯白纸面，清爽的灰阶与细线', '明亮', {
    bg: '#f5f6f7', sidebar: '#fafafa', line: '#dedfe2', text: '#24272c', muted: '#777d86',
    subtle: '#59616c', purple: '#34465a', 'purple-strong': '#34465a', 'purple-wash': '#eaf0f5',
    hover: '#edf0f3', 'quote-bg': '#f3f5f7', 'quote-text': '#495563', 'code-bg': '#f5f6f8',
    'button-radius': '4px', 'card-radius': '4px', shadow: 'none',
  }),
  appearance('parchment', '暖纸书房', '奶油纸色与宋体，像翻阅一本书', '暖纸', {
    bg: '#eae4d8', surface: '#faf5e9', sidebar: '#f1eadc', paper: '#fff9ed', line: '#dfd3bd',
    text: '#382f25', muted: '#8b7b65', subtle: '#75634e', purple: '#8b5d32', 'purple-strong': '#83582f',
    'purple-wash': '#efe2cc', hover: '#f0e7d6', 'code-bg': '#f3ecdd', 'reading-text': '#3e3429',
    'quote-bg': '#f2e8d4', 'quote-text': '#71583e', 'code-text': '#654e36',
    'button-radius': '9px', 'card-radius': '12px', shadow: '0 4px 20px #66513212', 'reading-font': serif,
  }),
  appearance('sage', '青竹护眼', '柔和豆绿底色，轻盈的圆角控件', '柔绿', {
    bg: '#e1e9df', surface: '#f1f6ee', sidebar: '#e8f0e4', paper: '#edf4e8', line: '#ccd9c6',
    text: '#293b2e', muted: '#788b77', subtle: '#586e58', purple: '#3f7351', 'purple-strong': '#456d4e',
    'purple-wash': '#dce9d5', hover: '#e1ecda', 'code-bg': '#e4eddf', 'reading-text': '#2e4031',
    'quote-bg': '#dfead8', 'quote-text': '#4c654a', 'code-text': '#35533b',
    'button-radius': '14px', 'card-radius': '14px', shadow: '0 5px 20px #344d3010',
  }),
  appearance('mist', '雾蓝书桌', '冷调蓝灰与利落边线，适合资料阅读', '雾蓝', {
    bg: '#e4ecf2', surface: '#f6f9fc', sidebar: '#eaf0f6', paper: '#f0f6fb', line: '#cddce7',
    text: '#263b4e', muted: '#778d9f', subtle: '#506d85', purple: '#356c95', 'purple-strong': '#376a8f',
    'purple-wash': '#dceaf5', hover: '#e1edf6', 'code-bg': '#e7eff6', 'reading-text': '#2c4052',
    'quote-bg': '#e1edf5', 'quote-text': '#496880', 'code-text': '#345570',
    'button-radius': '3px', 'card-radius': '5px', shadow: '0 3px 14px #2747660c',
  }),
  appearance('rose', '玫瑰信笺', '浅玫瑰纸面与衬线文字，温柔安静', '信笺', {
    bg: '#f0e6e7', surface: '#fdf6f5', sidebar: '#f6eded', paper: '#fff7f4', line: '#e7d2d5',
    text: '#483035', muted: '#a17d84', subtle: '#835e68', purple: '#99596e', 'purple-strong': '#97576a',
    'purple-wash': '#f3dfe5', hover: '#f6e6e9', 'code-bg': '#f5e9e9', 'reading-text': '#493439',
    'quote-bg': '#f6e6e7', 'quote-text': '#805762', 'code-text': '#704754',
    'button-radius': '16px', 'card-radius': '14px', shadow: '0 5px 20px #81546010', 'reading-font': serif,
  }),
  appearance('sand', '沙丘手记', '亚麻底色、赭石重点，朴素的笔记感', '亚麻', {
    bg: '#e7dfd3', surface: '#f7f2e9', sidebar: '#eee7db', paper: '#f8f1e4', line: '#d9cab6',
    text: '#40382d', muted: '#94826b', subtle: '#78664f', purple: '#a16337', 'purple-strong': '#965c32',
    'purple-wash': '#edddc6', hover: '#eee2d2', 'code-bg': '#eee5d7', 'reading-text': '#443b2e',
    'quote-bg': '#eee0cb', 'quote-text': '#6c533a', 'code-text': '#705339',
    'button-radius': '2px', 'card-radius': '2px', shadow: '3px 3px 0 #d9cab650', 'reading-font': serif,
  }),
  appearance('ink', '水墨书卷', '黑白留素、朱砂点睛，清晰的书卷层次', '水墨', {
    bg: '#e9e9e5', surface: '#fafaf6', sidebar: '#f0f0ea', paper: '#f9f9f3', line: '#d4d4c9',
    text: '#252923', muted: '#7d8176', subtle: '#5f6558', purple: '#985044', 'purple-strong': '#944d40',
    'purple-wash': '#f0e3dd', hover: '#e9e9df', 'code-bg': '#eeeee6', 'reading-text': '#2a2e27',
    'quote-bg': '#edeee5', 'quote-text': '#5f6658', 'code-text': '#484f41',
    'button-radius': '0px', 'card-radius': '0px', shadow: 'none', 'reading-font': serif, 'interface-font': serif,
  }),
  appearance('midnight', '午夜静读', '深靛蓝纸面与月光文字，适合夜间阅读', '夜读', {
    bg: '#151c2b', surface: '#1d2738', sidebar: '#192232', paper: '#202b3e', line: '#344158',
    text: '#e1e7f1', muted: '#8898af', subtle: '#afbed2', purple: '#a9bce9', 'purple-strong': '#536a9c',
    'purple-wash': '#303e58', hover: '#2b374e', 'code-bg': '#192335', 'reading-text': '#d7e0ed',
    'quote-bg': '#28364b', 'quote-text': '#b4c6de', 'code-text': '#bdd0eb',
    'button-radius': '10px', 'card-radius': '12px', shadow: '0 5px 24px #00000020',
  }, true),
  appearance('charcoal', '石墨专注', '低彩度炭灰与柔白文字，减少视觉干扰', '石墨', {
    bg: '#202122', surface: '#292b2c', sidebar: '#242627', paper: '#2c2e2e', line: '#454949',
    text: '#e6e7e3', muted: '#949b98', subtle: '#b5beb8', purple: '#bfd0b9', 'purple-strong': '#566b52',
    'purple-wash': '#3a4738', hover: '#383e39', 'code-bg': '#242727', 'reading-text': '#daddd6',
    'quote-bg': '#343b35', 'quote-text': '#bdc9b9', 'code-text': '#c8d4c2',
    'button-radius': '3px', 'card-radius': '4px', shadow: 'none',
  }, true),
];

export function resolveReadingStyle(id, legacyDark = false) {
  return READING_STYLES.find(style => style.id === id)
    || READING_STYLES.find(style => style.id === (legacyDark ? 'midnight' : 'default'));
}

export function applyReadingStyle(root, id) {
  const style = resolveReadingStyle(id);
  root.dataset.style = style.id;
  root.dataset.theme = style.dark ? 'dark' : 'light';
  root.style.colorScheme = style.dark ? 'dark' : 'light';
  for (const [token, value] of Object.entries(style.tokens)) root.style.setProperty(`--${token}`, value);
  return style;
}
