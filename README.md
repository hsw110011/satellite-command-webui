# 多源融合定位地图交互界面

基于 ROS1 Noetic 的卫星遥感定位可视化与区域指令交互系统。提供地图叠加轨迹、区域框选发布、定位程序生命周期管理、Agent/VLM 协同接口。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        WebUI (浏览器)                             │
│  地图视口 · 区域绘制 · 轨迹渲染 · 遥测面板 · Agent 交互          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP / SSE (port 3000)
┌───────────────────────────┴─────────────────────────────────────┐
│               Python Gateway (FastAPI + rospy)                    │
│  ros_backend/app.py                                              │
│  - 订阅 /fix (NavSatFix) 和 /odom (Odometry)                    │
│  - 发布 /selected_region (skyforge_msgs/RegionCommand)           │
│  - 管理 roslaunch 定位程序生命周期                                │
│  - SSE 实时推送遥测、状态、区域变更                               │
└───────────────────────────┬─────────────────────────────────────┘
                            │ rospy
┌───────────────────────────┴─────────────────────────────────────┐
│                     ROS1 Noetic Master                            │
│  定位节点 · GNSS 驱动 · IMU · 里程计 · 地图匹配                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 环境要求

| 组件 | 版本 |
|------|------|
| Ubuntu | 20.04 LTS |
| ROS | Noetic (desktop-full 或 ros-base) |
| Python | 3.8+ (系统 Python，rospy 依赖) |
| Node.js | 16+ (仅 demo 模式需要) |

---

## 安装步骤

### 1. 克隆项目

```bash
cd ~/catkin_ws/src
git clone <repo-url> satellite-command-webui
cd satellite-command-webui
```

### 2. 编译自定义消息

```bash
cd ros1_ws
catkin_make
source devel/setup.bash
```

编译后生成 `skyforge_msgs/RegionCommand` 消息类型。

### 3. 安装 Python 依赖

```bash
cd ~/catkin_ws/src/satellite-command-webui
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -r ros_backend/requirements.txt
```

> `--system-site-packages` 是必须的，让 venv 继承系统的 `rospy`、`std_msgs`、`geometry_msgs`。

### 4. 配置环境变量

```bash
cp config/skyforge.env.example config/skyforge.env
nano config/skyforge.env
```

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SKYFORGE_HOST` | `127.0.0.1` | Web 服务监听地址 |
| `SKYFORGE_PORT` | `3000` | Web 服务端口 |
| `SKYFORGE_ROS_NODE` | `skyforge_gateway` | 网关 ROS 节点名 |
| `SKYFORGE_FIX_TOPIC` | `/fix` | 订阅的 NavSatFix 话题（经纬度定位） |
| `SKYFORGE_ODOM_TOPIC` | `/odom` | 订阅的 Odometry 话题（航向/速度） |
| `SKYFORGE_REGION_TOPIC` | `/selected_region` | 发布区域指令的话题 |
| `SKYFORGE_LAUNCH_PACKAGE` | _(空)_ | 定位 launch 所在包名 |
| `SKYFORGE_LAUNCH_FILE` | _(空)_ | 定位 launch 文件名 |
| `SKYFORGE_LAUNCH_ARGS` | _(空)_ | launch 额外参数（空格分隔） |
| `SKYFORGE_SIMULATION` | `0` | 设为 1 启用模拟模式（不需要 ROS Master） |
| `SKYFORGE_ALLOW_STRING_FALLBACK` | `0` | skyforge_msgs 不可用时回退到 std_msgs/String |
| `SKYFORGE_ALLOW_REMOTE_AGENT` | `0` | 允许 Agent 调用外部 LangGraph 端点 |

---

## 运行

### ROS 模式（生产）

```bash
# 终端 1: ROS Master
roscore

# 终端 2: 定位程序（或由 WebUI 内部启动）
roslaunch your_package localization.launch

# 终端 3: WebUI Gateway
source /opt/ros/noetic/setup.bash
source ~/catkin_ws/src/satellite-command-webui/ros1_ws/devel/setup.bash
source ~/catkin_ws/src/satellite-command-webui/.venv/bin/activate
set -a && source config/skyforge.env && set +a
python3 -m ros_backend.app
```

浏览器访问 `http://127.0.0.1:3000`

### Demo 模式（无 ROS 环境预览前端）

```bash
npm start
```

此模式下后端为静态 Node.js 服务器，不连接 ROS，所有遥测和状态为模拟数据。

### 模拟模式（有 Python 无 ROS Master）

```bash
SKYFORGE_SIMULATION=1 python3 -m ros_backend.app
```

会生成模拟定位轨迹和状态，用于集成测试。

---

## 话题接口

### 订阅（输入）

| 话题 | 类型 | 频率 | 用途 |
|------|------|------|------|
| `/fix` | `sensor_msgs/NavSatFix` | 1–10 Hz | 经纬度、海拔 |
| `/odom` | `nav_msgs/Odometry` | 1–50 Hz | 航向、速度 |

前端通过 SSE 实时接收并渲染：
- 右侧遥测面板（LAT / LON / ALT / HDG / SPD / SRC）
- 下方 2D 轨迹画布和数据曲线
- **地图 SVG 覆盖层实时轨迹线**（经纬度转像素坐标叠加在卫星影像上）

### 发布（输出）

| 话题 | 类型 | 触发 | 用途 |
|------|------|------|------|
| `/selected_region` | `skyforge_msgs/RegionCommand` | 用户点击"发布" | 向下游节点发送区域指令 |

消息结构：

```
std_msgs/Header header
uint8 flag          # 0=GPS_FLAG, 1=DR_FLAG, 2=MATCH_FLAG
string region_id
string region_name
string shape        # "rectangle" 或 "polygon"
geometry_msgs/Point32[] points   # x=lon, y=lat, z=0
```

如果 `skyforge_msgs` 未编译，且 `SKYFORGE_ALLOW_STRING_FALLBACK=1`，则回退到 `std_msgs/String`（JSON 格式）。

---

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/system/status` | 系统状态（ROS Master、节点、消息类型、定位） |
| GET | `/api/regions` | 已保存区域列表 |
| POST | `/api/regions` | 创建区域 |
| DELETE | `/api/regions/:id` | 删除区域 |
| POST | `/api/publish/start` | 开始持续发布区域 |
| POST | `/api/publish/stop` | 停止发布 |
| POST | `/api/localization/start` | 启动定位 launch |
| POST | `/api/localization/stop` | 停止定位 launch |
| POST | `/api/agent/run` | 调用 Agent/VLM |
| POST | `/api/map/{dom|dsm}/upload` | 上传并加载完整 GeoTIFF |
| GET | `/api/map/{dom|dsm}/metadata` | 获取尺寸、CRS、边界与概览层级 |
| GET | `/api/map/{dom|dsm}/tile/{level}/{col}/{row}.png` | 按视口读取 GeoTIFF 栅格块 |
| POST | `/api/map/{dom|dsm}/coordinates` | WGS84 与原始栅格像素坐标互转 |
| GET | `/api/map/dsm/elevation` | 查询 DSM 指定位置的高程 |
| GET | `/events` | SSE 事件流 |

### SSE 事件类型

| 事件名 | 数据 | 说明 |
|--------|------|------|
| `hello` | 完整初始状态 | 连接建立时推送 |
| `telemetry` | `{lat, lon, altitude, heading, speed, source, topic}` | 每次定位更新 |
| `topic` | `{name}` | 订阅话题名称变更 |
| `publish` | `{flag, region}` | 每次区域发布 |
| `publish-state` | `{active, deliveryState, lastError}` | 发布状态变更 |
| `localization-state` | `{active, state, processes, lastError}` | 定位程序状态 |
| `system-status` | 完整系统状态 | 周期性推送 |
| `regions` | `{regions: [...]}` | 区域列表变更 |

---

## 地图数据

前端支持 DOM 与 DSM 两个独立地图视图：

| 方式 | 格式 | 说明 |
|------|------|------|
| 在线瓦片 | Esri World Imagery | 默认加载，需要网络 |
| DOM GeoTIFF | `.tif/.tiff/.geotiff` | 加载完整正射影像并读取文件内坐标系 |
| DSM GeoTIFF | `.tif/.tiff/.geotiff` | 加载完整表面模型、着色并提供高程查询 |

大尺寸 TIFF 不会先压缩成一张低清预览图。后端保留原始栅格，根据当前视口读取 256 像素块：全图状态自动使用概览层，放大到 `1:1` 时自动切换到 level 0 原始像素层。DOM 与 DSM 可分别滚轮缩放、拖动、适配全图和单图放大。

可用下面的命令检查 TIFF 是否包含坐标：

```bash
gdalinfo your-map.tif
```

---

## 轨迹渲染机制

1. 后端订阅 `/fix` 话题获取经纬度
2. 通过 SSE `telemetry` 事件推送到前端
3. 前端 `latLonToContent(lat, lon)` 将经纬度转换为地图像素坐标
4. 在地图 SVG 覆盖层绘制：
   - 连续 polyline 轨迹线（青蓝色）
   - 当前位置标记（实心圆 + 涟漪动画）
   - 轨迹起始点标记
5. 支持 Web Mercator（瓦片模式）和线性插值（单张影像模式）两种坐标变换
6. 保留最近 240 个点，超出自动移除最早点

---

## 目录结构

```
satellite-command-webui/
├── public/                  # 前端静态文件
│   ├── index.html          # 主界面
│   ├── styles.css          # 样式系统
│   ├── app.js              # 前端逻辑
│   └── skyforge.svg        # 图标
├── ros_backend/            # Python ROS Gateway
│   ├── app.py              # FastAPI 主入口
│   ├── ros_bridge.py       # rospy 桥接（订阅/发布/回调）
│   ├── localization_manager.py  # roslaunch 生命周期
│   ├── settings.py         # 环境变量配置
│   └── requirements.txt    # Python 依赖
├── ros1_ws/                # catkin 工作空间
│   └── src/skyforge_msgs/  # 自定义消息包
│       └── msg/RegionCommand.msg
├── config/
│   └── skyforge.env.example  # 环境变量模板
├── scripts/
│   ├── skyforge-launcher.sh      # Ubuntu 独立窗口启动脚本
│   └── install-ubuntu-launcher.sh # 桌面快捷方式安装
├── data/
│   └── regions.json        # 区域持久化存储
├── server.js               # Demo 模式 Node 服务器
└── package.json
```

---

## 给其他 ROS 节点集成的要点

1. **发布定位数据到 `/fix`**：使用 `sensor_msgs/NavSatFix`，填充 `latitude`、`longitude`、`altitude` 字段
2. **发布里程计到 `/odom`**：使用 `nav_msgs/Odometry`，WebUI 从中提取航向和速度
3. **订阅区域指令**：监听 `/selected_region`（类型 `skyforge_msgs/RegionCommand`），在地图匹配等节点中读取 `flag` 和 `points`
4. **话题名可配置**：修改 `config/skyforge.env` 中对应变量即可适配你的话题命名
5. **自定义消息编译**：确保 `ros1_ws/devel/setup.bash` 被 source，否则回退到 `std_msgs/String`

---

## 常见问题

**Q: 轨迹不显示？**
- 确认 `/fix` 话题有数据：`rostopic echo /fix`
- 确认经纬度在地图可视范围内
- 确认 SSE 连接正常（右上角 API 状态指示灯亮绿）

**Q: 区域发布失败？**
- 确认 `ros1_ws` 消息已编译并 source
- 或设置 `SKYFORGE_ALLOW_STRING_FALLBACK=1` 使用 JSON 回退

**Q: 定位程序启动失败？**
- 确认 `SKYFORGE_LAUNCH_PACKAGE` 和 `SKYFORGE_LAUNCH_FILE` 已正确配置
- 确认对应 launch 文件存在：`rospack find <package>`

**Q: 地图加载白屏？**
- 在线模式需要网络连接
- 离线环境点击“选择 TIFF”加载本地 GeoTIFF 文件
