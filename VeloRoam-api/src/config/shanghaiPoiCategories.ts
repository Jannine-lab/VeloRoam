export type HotPointCategory = 'scenic' | 'supply' | 'rest' | 'service' | 'start_end';

export interface ShanghaiDistrict {
  name: string;
  adcode: string;
}

export interface PoiCategoryQuery {
  keywords: string;
  types?: string;
  tags: string[];
  basePopularity: number;
  baseCyclist: number;
  baseService: number;
}

export interface PoiCategoryMapping {
  category: HotPointCategory;
  displayName: string;
  queries: PoiCategoryQuery[];
}

export const SHANGHAI_CITY_ADCODE = '310000';

export const SHANGHAI_DISTRICTS: ShanghaiDistrict[] = [
  { name: '黄浦区', adcode: '310101' },
  { name: '徐汇区', adcode: '310104' },
  { name: '长宁区', adcode: '310105' },
  { name: '静安区', adcode: '310106' },
  { name: '普陀区', adcode: '310107' },
  { name: '虹口区', adcode: '310109' },
  { name: '杨浦区', adcode: '310110' },
  { name: '闵行区', adcode: '310112' },
  { name: '宝山区', adcode: '310113' },
  { name: '嘉定区', adcode: '310114' },
  { name: '浦东新区', adcode: '310115' },
  { name: '金山区', adcode: '310116' },
  { name: '松江区', adcode: '310117' },
  { name: '青浦区', adcode: '310118' },
  { name: '奉贤区', adcode: '310120' },
  { name: '崇明区', adcode: '310151' }
];

export const SHANGHAI_POI_CATEGORY_MAPPINGS: PoiCategoryMapping[] = [
  {
    category: 'scenic',
    displayName: '景观点',
    queries: [
      {
        keywords: '公园|绿地|滨江|湿地|森林公园',
        types: '110000',
        tags: ['park', 'greenway', 'riverfront'],
        basePopularity: 62,
        baseCyclist: 74,
        baseService: 18
      },
      {
        keywords: '景点|地标|观景台|步道|广场',
        types: '110000',
        tags: ['landmark', 'viewpoint'],
        basePopularity: 70,
        baseCyclist: 64,
        baseService: 10
      }
    ]
  },
  {
    category: 'supply',
    displayName: '补给点',
    queries: [
      {
        keywords: '咖啡|咖啡馆|面包|轻食',
        types: '050000',
        tags: ['coffee', 'food'],
        basePopularity: 58,
        baseCyclist: 54,
        baseService: 72
      },
      {
        keywords: '便利店|超市|饮用水|补给',
        types: '060000',
        tags: ['convenience', 'water', 'supply'],
        basePopularity: 48,
        baseCyclist: 68,
        baseService: 82
      }
    ]
  },
  {
    category: 'rest',
    displayName: '休息点',
    queries: [
      {
        keywords: '公共厕所|洗手间|卫生间',
        types: '200000',
        tags: ['toilet', 'rest'],
        basePopularity: 40,
        baseCyclist: 66,
        baseService: 90
      },
      {
        keywords: '休息区|广场|游客中心|公园入口',
        types: '110000',
        tags: ['rest', 'entrance'],
        basePopularity: 52,
        baseCyclist: 62,
        baseService: 65
      }
    ]
  },
  {
    category: 'service',
    displayName: '骑行服务',
    queries: [
      {
        keywords: '自行车维修|电动车维修|修车|打气',
        types: '070000',
        tags: ['repair', 'bike_service'],
        basePopularity: 42,
        baseCyclist: 78,
        baseService: 88
      },
      {
        keywords: '自行车停车|非机动车停车|停车场',
        types: '150000',
        tags: ['parking', 'bike_service'],
        basePopularity: 38,
        baseCyclist: 64,
        baseService: 72
      }
    ]
  },
  {
    category: 'start_end',
    displayName: '热门起终点',
    queries: [
      {
        keywords: '绿道入口|骑行道|环城绿道|滨江步道',
        types: '110000',
        tags: ['start', 'greenway', 'cycling'],
        basePopularity: 60,
        baseCyclist: 88,
        baseService: 35
      },
      {
        keywords: '体育公园|自行车公园|骑行驿站|运动公园',
        types: '080000',
        tags: ['start', 'sports', 'cycling'],
        basePopularity: 56,
        baseCyclist: 84,
        baseService: 42
      }
    ]
  }
];
