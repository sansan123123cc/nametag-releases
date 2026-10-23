@echo off
setlocal
cd /d "%~dp0"
echo [이름표 학습] 환경 설치 시작
echo.
set "PY="
for %%v in (3.12 3.11 3.10) do ( if not defined PY ( py -%%v -c "import sys" >nul 2>nul && set "PY=py -%%v" ) )
if not defined PY ( where python >nul 2>nul && ( python -c "import sys;v=sys.version_info;sys.exit(0 if (3,10)<=(v.major,v.minor)<=(3,12) else 1)" >nul 2>nul && set "PY=python" ) )
if not defined PY ( for %%v in (312 311 310) do ( if not defined PY ( if exist "%LOCALAPPDATA%\Programs\Python\Python%%v\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python%%v\python.exe" ) ) )
if defined PY goto :found

echo Python 3.10~3.12 가 없다. winget 으로 Python 3.11 을 설치해 본다 (1~2분)...
winget install -e --id Python.Python.3.11 --scope user --accept-package-agreements --accept-source-agreements --silent
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" ( set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe" & goto :found )
echo.
echo 자동 설치가 안 됐다. 브라우저에서 python.org/downloads 에서 Python 3.11 을 받아 설치하고
echo ("Add python.exe to PATH" 체크) 이 메뉴를 다시 실행해라.
pause
exit /b 1

:found
echo 파이썬: %PY%
%PY% --version
set "VP=venv\Scripts\python.exe"
if exist %VP% ( %VP% -m pip --version >nul 2>nul || ( echo 깨진 가상환경 지움... & rmdir /s /q venv ) )
if not exist venv ( echo 가상환경 만드는 중... & %PY% -m venv venv )
if not exist %VP% ( echo 가상환경을 못 만들었다. & pause & exit /b 1 )
%VP% -m pip --version >nul 2>nul || %VP% -m ensurepip --upgrade
%VP% -m pip --version >nul 2>nul || ( echo pip 이 없어서 받는다... & curl -L https://bootstrap.pypa.io/get-pip.py -o get-pip.py && %VP% get-pip.py )
%VP% -m pip --version >nul 2>nul || ( echo pip 을 못 만들었다. python.org 에서 3.11 을 다시 설치해라. & pause & exit /b 1 )
%VP% -m pip install --upgrade pip
echo.
echo CUDA 12.8 용 torch 설치 (RTX 50xx 는 cu128 이상이어야 GPU 를 잡는다. 그래픽카드 없으면 CPU 로 돈다. 2.5GB 받음)
%VP% -m pip uninstall -y torch torchvision >nul 2>nul
%VP% -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
%VP% -m pip install ultralytics onnx onnxslim onnxruntime opencv-python numpy
echo.
%VP% -c "import torch;ok=torch.cuda.is_available();print('torch',torch.__version__,'CUDA',ok,torch.cuda.get_device_name(0) if ok else '(GPU 못 잡음 - CPU 로 돈다. NVIDIA 드라이버를 최신으로)')"
%VP% -c "import ultralytics;print('ultralytics',ultralytics.__version__)" || ( echo. & echo *** 설치 실패: ultralytics 가 안 깔렸다. 위 오류를 보고 다시 실행해라. & pause & exit /b 1 )
echo.
echo 설치 끝. 편집기 설정에서 [파이썬 정밀 검수] 를 켤 수 있고, 메뉴 [학습 - 2. 학습 시작] 도 된다.
pause
