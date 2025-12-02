#!/bin/bash

# ==========================================
# Build Verification System - 管理腳本 (v1.2)
# ==========================================

# 定義顏色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 定義 Log 檔案 (開發模式用)
LOG_DIR="logs"
DEV_BACKEND_LOG="$LOG_DIR/dev-backend.log"
DEV_FRONTEND_LOG="$LOG_DIR/dev-frontend.log"
PID_DIR=".pids"

# 確保目錄存在
mkdir -p $LOG_DIR
mkdir -p $PID_DIR

# ------------------------------------------
# 輔助函數
# ------------------------------------------

# 強制清理幽靈程序 (Ghost Processes)
force_cleanup() {
    echo -e "${YELLOW}正在檢查並清理佔用 Port 的幽靈程序...${NC}"
    
    # 檢查 Port 3001 (後端)
    if lsof -Pi :3001 -sTCP:LISTEN -t >/dev/null ; then
        echo -e "${RED}發現 Port 3001 被佔用 (可能是舊的 Server)，正在強制終止...${NC}"
        # 嘗試使用 fuser 殺死程序，如果沒有 fuser 則嘗試 kill PID
        fuser -k 3001/tcp >/dev/null 2>&1 || kill -9 $(lsof -t -i:3001) 2>/dev/null
    fi

    # 檢查 Port 5173 (前端)
    if lsof -Pi :5173 -sTCP:LISTEN -t >/dev/null ; then
        echo -e "${RED}發現 Port 5173 被佔用 (可能是舊的 Vite)，正在強制終止...${NC}"
        fuser -k 5173/tcp >/dev/null 2>&1 || kill -9 $(lsof -t -i:5173) 2>/dev/null
    fi
    
    # 等待一秒讓系統釋放資源
    sleep 1
    
    # 再次確認
    if lsof -Pi :3001 -sTCP:LISTEN -t >/dev/null || lsof -Pi :5173 -sTCP:LISTEN -t >/dev/null ; then
         echo -e "${RED}警告：無法自動清除所有程序，可能需要 sudo 權限。${NC}"
         echo -e "請手動執行: sudo fuser -k 3001/tcp && sudo fuser -k 5173/tcp"
         # 這裡不強制退出，嘗試繼續執行
    else
         echo -e "${GREEN}環境檢查完畢，Port 3001 與 5173 皆可用。${NC}"
    fi
}

stop_dev() {
    echo -e "${YELLOW}正在停止開發模式...${NC}"
    
    if [ -f "$PID_DIR/backend.pid" ]; then
        kill $(cat "$PID_DIR/backend.pid") 2>/dev/null
        rm "$PID_DIR/backend.pid"
        echo "已停止後端 Dev Server"
    fi
    
    if [ -f "$PID_DIR/frontend.pid" ]; then
        # Vite 啟動的 process 可能需要 kill process group
        pkill -P $(cat "$PID_DIR/frontend.pid") 2>/dev/null
        kill $(cat "$PID_DIR/frontend.pid") 2>/dev/null
        rm "$PID_DIR/frontend.pid"
        echo "已停止前端 Vite Server"
    fi
    
    # 額外執行一次強制清理，確保乾淨
    force_cleanup
    
    echo -e "${GREEN}開發模式已完全停止。${NC}"
}

stop_prod() {
    echo -e "${YELLOW}正在完全停止正式佈署 (PM2 Delete)...${NC}"
    # 改用 delete 來完全移除進程，而不只是 stop (暫停)
    pm2 delete build-backend 2>/dev/null
    pm2 delete build-frontend 2>/dev/null
    
    # 確保 PM2 釋放後沒有殘留
    force_cleanup
    
    echo -e "${GREEN}正式佈署已從 PM2 列表中移除。${NC}"
}

# ------------------------------------------
# 主功能與選單邏輯
# ------------------------------------------

# 如果沒有提供參數，顯示互動式選單
if [ -z "$1" ]; then
    echo "=========================================="
    echo "  Build Verification System - 管理選單"
    echo "=========================================="
    echo "請輸入數字選擇要執行的指令:"
    echo " 1. dev-start   : 啟動開發模式 (背景執行，寫入 logs/)"
    echo " 2. dev-stop    : 停止開發模式"
    echo " 3. prod-start  : 編譯並透過 PM2 啟動正式環境"
    echo " 4. prod-stop   : 完全停止 PM2 正式環境"
    echo " 5. restart     : 重啟 PM2 (正式環境用)"
    echo " 6. status      : 查看目前運作狀態"
    echo "=========================================="
    read -p "請輸入選項 [1-6]: " choice
    
    case "$choice" in
        1) ACTION="dev-start" ;;
        2) ACTION="dev-stop" ;;
        3) ACTION="prod-start" ;;
        4) ACTION="prod-stop" ;;
        5) ACTION="restart" ;;
        6) ACTION="status" ;;
        *) echo -e "${RED}無效的選項！請重新執行並輸入 1-6。${NC}"; exit 1 ;;
    esac
else
    ACTION="$1"
fi

# 執行對應動作
case "$ACTION" in
  dev-start)
    echo -e "${GREEN}=== 啟動開發模式 (Dev Mode) ===${NC}"
    
    # 1. 先嘗試停止可能存在的 PM2
    pm2 stop build-backend 2>/dev/null
    pm2 stop build-frontend 2>/dev/null
    
    # 2. 強制清理幽靈程序 (取代原本的 check_port)
    force_cleanup
    
    echo "啟動後端 (server.js)... Log: $DEV_BACKEND_LOG"
    nohup node server.js > "$DEV_BACKEND_LOG" 2>&1 &
    echo $! > "$PID_DIR/backend.pid"
    
    # 加入 -- --host 參數，讓 Vite 監聽所有網路介面 (0.0.0.0)
    echo "啟動前端 (npm run dev -- --host)... Log: $DEV_FRONTEND_LOG"
    nohup npm run dev -- --host > "$DEV_FRONTEND_LOG" 2>&1 &
    echo $! > "$PID_DIR/frontend.pid"
    
    echo -e "${GREEN}開發環境已在背景啟動！${NC}"
    echo -e "您可以輸入以下指令查看即時 Log："
    echo -e "  tail -f $DEV_BACKEND_LOG"
    echo -e "  tail -f $DEV_FRONTEND_LOG"
    ;;

  dev-stop)
    stop_dev
    ;;

  prod-start)
    echo -e "${GREEN}=== 啟動正式佈署 (Production Mode) ===${NC}"
    
    # 1. 先停止開發模式
    stop_dev
    
    # 2. 強制清理幽靈程序
    force_cleanup
    
    # 3. 重新編譯前端
    echo "正在編譯前端 (npm run build)..."
    npm run build
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}編譯成功！${NC}"
    else
        echo -e "${RED}編譯失敗，請檢查錯誤訊息。${NC}"
        exit 1
    fi

    # 4. 使用 PM2 啟動
    echo "啟動 PM2 服務..."
    
    if pm2 list | grep -q "build-backend"; then
        pm2 restart build-backend
    else
        pm2 start server.js --name "build-backend"
    fi

    if pm2 list | grep -q "build-frontend"; then
        pm2 restart build-frontend
    else
        pm2 start serve --name "build-frontend" -- -s dist -l 5173
    fi
    
    pm2 save
    echo -e "${GREEN}正式環境已上線！ (Port 3001 & 5173)${NC}"
    ;;

  prod-stop)
    stop_prod
    ;;

  restart)
    echo "重啟正式環境..."
    pm2 restart all
    ;;

  status)
    echo -e "${YELLOW}--- PM2 狀態 ---${NC}"
    pm2 list
    echo -e "\n${YELLOW}--- 開發模式 PIDs ---${NC}"
    if [ -f "$PID_DIR/backend.pid" ]; then echo "Dev Backend: Running (PID $(cat $PID_DIR/backend.pid))"; else echo "Dev Backend: Stopped"; fi
    if [ -f "$PID_DIR/frontend.pid" ]; then echo "Dev Frontend: Running (PID $(cat $PID_DIR/frontend.pid))"; else echo "Dev Frontend: Stopped"; fi
    
    echo -e "\n${YELLOW}--- Port 佔用情況 ---${NC}"
    echo -n "Port 3001 (Backend): "
    lsof -Pi :3001 -sTCP:LISTEN -t >/dev/null && echo -e "${RED}占用中${NC}" || echo -e "${GREEN}空閒${NC}"
    echo -n "Port 5173 (Frontend): "
    lsof -Pi :5173 -sTCP:LISTEN -t >/dev/null && echo -e "${RED}占用中${NC}" || echo -e "${GREEN}空閒${NC}"
    ;;

  *)
    echo "使用方法: ./manage.sh [指令] 或直接執行 ./manage.sh 開啟選單"
    echo "指令列表:"
    echo "  dev-start   : 啟動開發模式 (自動清除舊程序)"
    echo "  dev-stop    : 停止開發模式"
    echo "  prod-start  : 編譯並透過 PM2 啟動正式環境"
    echo "  prod-stop   : 完全停止 PM2 正式環境"
    echo "  restart     : 重啟 PM2 (正式環境用)"
    echo "  status      : 查看目前運作狀態與 Port 佔用"
    exit 1
    ;;
esac
