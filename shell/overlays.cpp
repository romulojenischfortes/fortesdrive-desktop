#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <atomic>
#include <fstream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <mutex>
#include <cwctype>

// Read-only Explorer extension: no network requests and no file-content changes.
static HMODULE moduleHandle;
static std::atomic<long> objects{0};
static const CLSID ids[] = {
  {0x9e76e330,0x7ab7,0x4afe,{0xb9,0x12,0x2a,0x30,0x5b,0xcd,0x4f,0x01}},
  {0x9e76e330,0x7ab7,0x4afe,{0xb9,0x12,0x2a,0x30,0x5b,0xcd,0x4f,0x02}},
  {0x9e76e330,0x7ab7,0x4afe,{0xb9,0x12,0x2a,0x30,0x5b,0xcd,0x4f,0x03}}
};
struct Entry { int state = 1; long long size = -1, time = -1; };
static std::mutex cacheMutex;
static std::wstring cachedRoot;
static ULONGLONG cachedStamp = 0;
static std::unordered_map<std::wstring, Entry> cache;
static std::wstring lower(std::wstring value) { for(auto& c : value) { if(c == L'/') c = L'\\'; c = towlower(c); } return value; }
static std::wstring widen(const std::string& value) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), (int)value.size(), nullptr, 0);
  std::wstring result(n, 0); if(n) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), (int)value.size(), result.data(), n); return result;
}
static std::wstring rootPath() {
  wchar_t buffer[32768]; DWORD bytes = sizeof(buffer);
  if(RegGetValueW(HKEY_CURRENT_USER,L"Software\\FortesDrive",L"SyncRoot",RRF_RT_REG_SZ,nullptr,buffer,&bytes) != ERROR_SUCCESS) return L"";
  std::wstring root(buffer); while(root.size() > 3 && root.back() == L'\\') root.pop_back(); return root;
}
static ULONGLONG stamp(const FILETIME& time) { ULARGE_INTEGER value; value.LowPart=time.dwLowDateTime; value.HighPart=time.dwHighDateTime; return value.QuadPart; }
static void load(const std::wstring& root) {
  const auto filename = root + L"\\.fortesdrive\\shell-status.tsv";
  WIN32_FILE_ATTRIBUTE_DATA info{};
  if(!GetFileAttributesExW(filename.c_str(), GetFileExInfoStandard, &info)) {cache.clear(); cachedStamp=0; cachedRoot=root; return;}
  auto version = stamp(info.ftLastWriteTime);
  if(root == cachedRoot && version == cachedStamp) return;
  cache.clear(); cachedRoot=root; cachedStamp=version;
  // A bounded local file, never read an arbitrary or remote URL in Explorer.
  if(info.nFileSizeHigh || info.nFileSizeLow > 64*1024*1024) return;
  std::ifstream input(filename.c_str()); std::string line;
  while(std::getline(input,line)) {
    std::istringstream fields(line); std::string state, size, time, relative;
    if(!std::getline(fields,state,'\t') || !std::getline(fields,size,'\t') || !std::getline(fields,time,'\t')) continue;
    std::getline(fields,relative);
    try {Entry entry; entry.state=state=="synced"?0:state=="error"?2:1; entry.size=std::stoll(size); entry.time=std::stoll(time); cache[lower(widen(relative))]=entry;} catch(...) {}
  }
}
class Overlay final : public IShellIconOverlayIdentifier {
  std::atomic<ULONG> refs{1}; int state;
public:
  explicit Overlay(int s):state(s){objects++;} ~Overlay(){objects--;}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** out) override {if(!out)return E_POINTER; *out=nullptr; if(iid==IID_IUnknown || iid==IID_IShellIconOverlayIdentifier){*out=static_cast<IShellIconOverlayIdentifier*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
  ULONG STDMETHODCALLTYPE AddRef() override {return ++refs;}
  ULONG STDMETHODCALLTYPE Release() override {auto n=--refs;if(!n)delete this;return n;}
  HRESULT STDMETHODCALLTYPE GetOverlayInfo(LPWSTR file,int count,int* index,DWORD* flags) override {
    if(!file||!index||!flags)return E_POINTER;
    DWORD n=GetModuleFileNameW(moduleHandle,file,count);if(!n||n>=(DWORD)count)return E_FAIL;
    *index=state;*flags=ISIOI_ICONFILE|ISIOI_ICONINDEX;return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetPriority(int* priority) override {if(!priority)return E_POINTER;*priority=state==2?0:state==1?1:2;return S_OK;}
  HRESULT STDMETHODCALLTYPE IsMemberOf(LPCWSTR filename,DWORD) override {
    if(!filename)return S_FALSE;
    try {
      const auto root=rootPath(), r=lower(root), file=lower(filename);
      if(r.empty())return S_FALSE;
      const auto prefix=r.back()==L'\\'?r:r+L"\\";
      if(file!=r && file.rfind(prefix,0)!=0)return S_FALSE;
      const auto relative=file==r?L"":file.substr(prefix.size());
      if(relative==L".fortesdrive" || relative.rfind(L".fortesdrive\\",0)==0)return S_FALSE;
      Entry entry;
      {std::lock_guard<std::mutex> lock(cacheMutex);load(root);auto found=cache.find(relative);if(found!=cache.end())entry=found->second;}
      WIN32_FILE_ATTRIBUTE_DATA attrs{};if(!GetFileAttributesExW(filename,GetFileExInfoStandard,&attrs))return S_FALSE;
      if(entry.state==0 && !(attrs.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)) {
        ULARGE_INTEGER size;size.LowPart=attrs.nFileSizeLow;size.HighPart=attrs.nFileSizeHigh;
        const auto modified=(long long)(stamp(attrs.ftLastWriteTime)/10000)-11644473600000LL;
        if(entry.size!=(long long)size.QuadPart || entry.time!=modified)entry.state=1;
      }
      return entry.state==state?S_OK:S_FALSE;
    } catch(...) {return S_FALSE;}
  }
};
class Factory final : public IClassFactory {
  std::atomic<ULONG> refs{1};int state;
public:
  explicit Factory(int s):state(s){objects++;}~Factory(){objects--;}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** out) override {if(!out)return E_POINTER;*out=nullptr;if(iid==IID_IUnknown||iid==IID_IClassFactory){*out=static_cast<IClassFactory*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
  ULONG STDMETHODCALLTYPE AddRef() override{return ++refs;}
  ULONG STDMETHODCALLTYPE Release() override{auto n=--refs;if(!n)delete this;return n;}
  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* outer,REFIID iid,void** out) override{if(outer)return CLASS_E_NOAGGREGATION;auto object=new Overlay(state);auto hr=object->QueryInterface(iid,out);object->Release();return hr;}
  HRESULT STDMETHODCALLTYPE LockServer(BOOL lock) override{if(lock)objects++;else objects--;return S_OK;}
};
extern "C" HRESULT __stdcall DllGetClassObject(REFCLSID clsid,REFIID iid,void** out) {
  for(int i=0;i<3;i++)if(clsid==ids[i]){auto factory=new Factory(i);auto hr=factory->QueryInterface(iid,out);factory->Release();return hr;}return CLASS_E_CLASSNOTAVAILABLE;
}
extern "C" HRESULT __stdcall DllCanUnloadNow(){return objects.load()==0?S_OK:S_FALSE;}
extern "C" void CALLBACK Refresh(HWND,HINSTANCE,LPSTR,int) {
  const auto root=rootPath();if(root.empty())return;
  SHChangeNotify(SHCNE_UPDATEITEM,SHCNF_PATHW,root.c_str(),nullptr);
  SHChangeNotify(SHCNE_UPDATEDIR,SHCNF_PATHW,root.c_str(),nullptr);
  std::lock_guard<std::mutex> lock(cacheMutex);load(root);
  for(const auto& pair:cache)if(!pair.first.empty()) {const auto item=root+L"\\"+pair.first;SHChangeNotify(SHCNE_UPDATEITEM,SHCNF_PATHW,item.c_str(),nullptr);}
}
BOOL APIENTRY DllMain(HMODULE handle,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){moduleHandle=handle;DisableThreadLibraryCalls(handle);}return TRUE;}