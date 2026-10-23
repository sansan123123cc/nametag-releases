@echo off
cd /d "%~dp0"
if not exist out\ntd11_seg_v5_1024.onnx ( echo 학습 결과(out\ntd11_seg_v5_1024.onnx)가 없다. [2. 학습 시작] 먼저. & pause & exit /b 1 )
if not exist ..\models mkdir ..\models
if not exist ..\models\_이전 mkdir ..\models\_이전
for %%f in (..\models\*.onnx) do ( move /y "%%f" "..\models\_이전\%%~nxf.%date:~0,4%%date:~5,2%%date:~8,2%" >nul )
copy /y out\ntd11_seg_v5_1024.onnx ..\models\ntd11_seg_v5_1024.onnx >nul
echo models\ntd11_seg_v5_1024.onnx 로 넣었다. 편집기에서 [보기 - 새로고침] 하면 새 모델을 쓴다.
pause
