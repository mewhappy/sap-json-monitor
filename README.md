# SAP Monitor

Web server ที่รับ HTTP POST จาก SAP (ใช้แทน webhook.site) และแสดงข้อมูลแบบ real-time

## ติดตั้ง / รัน

```powershell
npm install
npm start            # หรือ start.bat
```

ตั้ง user/password และค่าอื่น ๆ ผ่าน environment variable (ค่า default อยู่ในวงเล็บ):

| ตัวแปร | ความหมาย |
|---|---|
| `SAP_AUTH` (`false`) | `true` = `/sap` ต้องส่ง Basic Auth มาด้วย |
| `ALLOW_IPS` (ว่าง = รับทุก IP) | รับ `/sap` เฉพาะ IP ที่กำหนด เช่น `172.23.0.13,127.0.0.1` |
| `SAP_USER` (`sapuser`) / `SAP_PASS` (`sappass`) | Basic Auth สำหรับหน้าเว็บ (และ `/sap` ถ้า `SAP_AUTH=true`) |
| `PORT` (`3000`), `HOST` (`0.0.0.0`) | ที่อยู่ที่ server listen |
| `PROTECT_UI` (`true`) | `false` = เปิดหน้าเว็บโดยไม่ต้อง login |
| `MAX_MEMORY` (`500`) | จำนวนรายการล่าสุดที่แสดงบนหน้าเว็บ |
| `BODY_LIMIT` (`50mb`) | ขนาด body สูงสุด |

```powershell
$env:SAP_USER="myuser"; $env:SAP_PASS="StrongPass!"; npm start
```

## เปิด Windows Firewall (ทำครั้งเดียว)

เปิด PowerShell แบบ **Run as Administrator** แล้วรัน:

```powershell
cd "C:\Users\Tachchapan\Web App\Monitor SAP"
powershell -ExecutionPolicy Bypass -File .\open-firewall.ps1
```

## Endpoint

| Method | URL | ใช้ทำอะไร |
|---|---|---|
| POST | `http://<server-ip>:3000/sap` | SAP ส่งข้อมูลเข้ามา (หรือ `/sap/<interface>` เช่น `/sap/so-invoice`) |
| GET | `http://<server-ip>:3000/sap` | ดึงข้อมูลล่าสุดเป็น JSON (`?limit=N`, ค่าเริ่มต้น 50; `/sap/<interface>` = กรองตาม interface) |
| GET | `http://<server-ip>:3000/monitor` | หน้าเว็บดูข้อมูลแบบ real-time (`/` จะ redirect มาที่นี่) |

POST:
- ไม่ต้องใส่ user/password (เปิดได้ด้วย `SAP_AUTH=true`)
- รับ body ได้ทุก content type (JSON / XML / text)
- ตอบกลับ `200` พร้อมข้อมูลที่ได้รับ เพื่อให้ฝั่งผู้ส่ง (เช่น ABAP) ตรวจได้ว่าส่งถึงจริง:
  `{"status":"OK","id":"<uuid>","time":"...","interface":"abap-test","bodyType":"json","size":123,"received":{...}}`
  ถ้า Content-Type เป็น JSON แต่ body ไม่ใช่ JSON ที่ถูกต้อง จะมี `"warning"` เพิ่มมา
- IP ไม่อยู่ใน `ALLOW_IPS` → `403`, user/pass ผิด (เมื่อเปิด auth) → `401`, method อื่นที่ไม่ใช่ GET/POST → `405`

ทดสอบ:

```bash
curl -H "Content-Type: application/json" -d '{"VBELN":"9000001"}' http://<server-ip>:3000/sap
```

## ทดสอบจาก SAP ABAP

โปรแกรมตัวอย่าง: [abap/ZSAP_MONITOR_POST_TEST.abap](abap/ZSAP_MONITOR_POST_TEST.abap)
สร้าง report ใน SE38 แล้ววางโค้ดนี้ ใช้ `cl_http_client` POST JSON (serialize ด้วย `/ui2/cl_json`) แล้วแสดง HTTP status, id และ response

- ส่งตรงด้วย URL: ใส่ `P_URL` = `http://<server-ip>:3000/sap` และ `P_IFACE` = ชื่อ interface (ได้ URL `/sap/<interface>`)
- ส่งผ่าน SM59: สร้าง destination ประเภท **G** ใส่ Target Host = `<server-ip>`, Service No. = `3000`, Path Prefix = `/sap/abap-test` แล้วใส่ชื่อใน `P_DEST`
- `P_USER` / `P_PASS` ใช้เมื่อเปิด `SAP_AUTH=true`

ถ้าส่งไม่ถึง (HTTP error / timeout):
- เครื่อง SAP ต้องเข้าถึง `<server-ip>:3000` ได้ (เปิด firewall ตามข้างบน, อยู่ network เดียวกันหรือ route ถึง)
- ถ้า SAP ออก network ผ่าน proxy ให้ใส่ IP นี้ใน no-proxy (transaction `SICF` > Client > Proxy Settings)
- ดูรายละเอียด error ได้ที่ `SMICM` > Goto > Trace File

## หน้าเว็บ

`http://<server-ip>:3000/monitor` แสดงรายการ request ล่าสุด รายการใหม่จะขึ้นเองผ่าน Server-Sent Events
คลิกรายการเพื่อดู header และ body (จัดรูปแบบ JSON/XML ให้อ่านง่าย, กด Raw เพื่อดูต้นฉบับ)
กรองตาม interface หรือค้นหาจาก path หรือ id ได้

## Log

ทุก request ถูกเก็บใน `logs/requests-YYYY-MM-DD.jsonl` (1 บรรทัดต่อ 1 request: เวลา, method, path, headers, body)
ค่า header `Authorization` จะถูกปิดเป็น `***` ก่อนบันทึก
ปุ่ม "ล้างรายการ" ลบเฉพาะรายการบนหน้าจอ ไฟล์ log ยังอยู่
