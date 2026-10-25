#include "overlays.cpp"
#include <filesystem>
#include <iostream>
#include <stdexcept>
static void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
struct RestoreRoot {
  std::wstring old=rootPath();
  ~RestoreRoot(){HKEY key;if(RegCreateKeyExW(HKEY_CURRENT_USER,L"Software\\FortesDrive",0,nullptr,0,KEY_SET_VALUE,nullptr,&key,nullptr)==ERROR_SUCCESS){if(old.empty())RegDeleteValueW(key,L"SyncRoot");else RegSetValueExW(key,L"SyncRoot",0,REG_SZ,(const BYTE*)old.c_str(),(DWORD)((old.size()+1)*sizeof(wchar_t)));RegCloseKey(key);}}
};
int wmain() {
  RestoreRoot restore;
  wchar_t temp[MAX_PATH];GetTempPathW(MAX_PATH,temp);
  const auto root=std::wstring(temp)+L"fortesdrive-overlay-"+std::to_wstring(GetCurrentProcessId());
  const auto metadata=root+L"\\.fortesdrive", file=root+L"\\ação.txt", status=metadata+L"\\shell-status.tsv";
  try {
    std::filesystem::create_directories(metadata);
    HKEY key;require(RegCreateKeyExW(HKEY_CURRENT_USER,L"Software\\FortesDrive",0,nullptr,0,KEY_SET_VALUE,nullptr,&key,nullptr)==ERROR_SUCCESS,"registry");
    require(RegSetValueExW(key,L"SyncRoot",0,REG_SZ,(const BYTE*)root.c_str(),(DWORD)((root.size()+1)*sizeof(wchar_t)))==ERROR_SUCCESS,"root");RegCloseKey(key);
    {std::ofstream output(file.c_str(),std::ios::binary);output<<"hello";}
    WIN32_FILE_ATTRIBUTE_DATA attrs{};require(GetFileAttributesExW(file.c_str(),GetFileExInfoStandard,&attrs),"file attributes");
    auto ms=(long long)(stamp(attrs.ftLastWriteTime)/10000)-11644473600000LL;
    {std::ofstream output(status.c_str(),std::ios::binary);output<<"synced\t5\t"<<ms<<"\tação.txt\nsynced\t-1\t-1\t";}
    Overlay synced(0),pending(1),error(2);
    require(synced.IsMemberOf(file.c_str(),0)==S_OK,"synced file");
    require(synced.IsMemberOf(root.c_str(),0)==S_OK,"synced root");
    require(pending.IsMemberOf(file.c_str(),0)==S_FALSE,"one badge only");
    require(synced.IsMemberOf(temp,0)==S_FALSE,"outside root excluded");
    require(pending.IsMemberOf(metadata.c_str(),0)==S_FALSE,"internal directory excluded");
    {std::ofstream output(file.c_str(),std::ios::binary|std::ios::app);output<<"changed";}
    require(pending.IsMemberOf(file.c_str(),0)==S_OK,"changed content cannot stay green");
    Sleep(20);
    {std::ofstream output(status.c_str(),std::ios::binary);output<<"error\t-1\t-1\tação.txt\nerror\t-1\t-1\t";}
    require(error.IsMemberOf(file.c_str(),0)==S_OK,"error badge");
    require(error.IsMemberOf(root.c_str(),0)==S_OK,"error root");
    {std::ofstream output(status.c_str(),std::ios::binary);output<<"locked\t-1\t-1\tação.txt\nlocked\t-1\t-1\t";}
    Overlay locked(3);
    require(locked.IsMemberOf(file.c_str(),0)==S_OK,"locked badge");
    require(locked.IsMemberOf(root.c_str(),0)==S_OK,"locked root");
    require(error.IsMemberOf(file.c_str(),0)==S_FALSE,"apenas uma marca por item");
    moduleHandle=GetModuleHandleW(nullptr);wchar_t exe[MAX_PATH]{};GetModuleFileNameW(nullptr,exe,MAX_PATH);
    for(int state=0;state<4;state++){Overlay overlay(state);wchar_t iconFile[MAX_PATH]{};int index=-1;DWORD flags=0;require(overlay.GetOverlayInfo(iconFile,MAX_PATH,&index,&flags)==S_OK && index==state && (flags&ISIOI_ICONFILE) && (flags&ISIOI_ICONINDEX) && iconFile[0],"overlay icon reference");}
    std::wstring badges(exe);badges.resize(badges.find_last_of(L'\\')+1);badges+=L"FortesDriveOverlays.dll";
    require(ExtractIconExW(badges.c_str(),-1,nullptr,nullptr,0)==4,"four embedded badge icons");
    for(int state=0;state<4;state++){HICON icon=ExtractIconW(nullptr,badges.c_str(),state);require(icon!=nullptr,"badge icon readable by index");DestroyIcon(icon);}
    std::filesystem::remove_all(root);std::cout<<"Explorer badge tests passed\n";return 0;
  } catch(const std::exception& error){std::cerr<<error.what()<<"\n";std::filesystem::remove_all(root);return 1;}
}