import { defineI18nUI } from 'fumadocs-ui/i18n';
import { docsI18n } from './i18n';

// Fumadocs' own chrome strings (search box, TOC heading, pagination...). Keys not listed fall
// back to English. Content itself lives in content/docs/<locale>/.
export const docsI18nUI = defineI18nUI(docsI18n, {
  translations: {
    en: { displayName: 'English' },
    fr: {
      displayName: 'Français',
      search: 'Rechercher',
      searchNoResult: 'Aucun résultat',
      toc: 'Sur cette page',
      tocNoHeadings: 'Aucun titre',
      nextPage: 'Page suivante',
      previousPage: 'Page précédente',
      chooseTheme: 'Thème',
      chooseLanguage: 'Langue',
    },
    ar: {
      displayName: 'العربية',
      search: 'بحث',
      searchNoResult: 'لا توجد نتائج',
      toc: 'في هذه الصفحة',
      tocNoHeadings: 'لا توجد عناوين',
      nextPage: 'الصفحة التالية',
      previousPage: 'الصفحة السابقة',
      chooseTheme: 'المظهر',
      chooseLanguage: 'اللغة',
    },
  },
});
