// Copyright 2016 Cheng Zhao. All rights reserved.
// Use of this source code is governed by the license that can be found in the
// LICENSE file.

#ifndef LUA_WRAPPABLE_H_
#define LUA_WRAPPABLE_H_

#include "lua/table.h"
#include "lua/wrappable_internal.h"

namespace lua {

// Inherit this to provide metatable based class in lua.
template<typename T>
class Wrappable : public internal::WrappableBase {
 public:
  // Create the metatable of class and push it on stack.
  static void PushNewClass(State* state) {
    if (luaL_newmetatable(state, T::name) == 1) {
      RawSet(state, -1, "__index", ValueOnStack(state, -1),
                        "__gc", CFunction(&OnGC));
      T::BuildMetaTable(state, -1);
    }
  }

  // Create an instance of the class.
  // The returned pointer is managed by lua, so avoid keeping it.
  template<typename... ArgTypes>
  static T* NewInstance(State* state, const ArgTypes&... args) {
    StackAutoReset reset(state);
    void* memory = lua_newuserdata(state, sizeof(T));
    T* instance = new(memory) T(state, args...);
    luaL_getmetatable(state, T::name);
    DCHECK_EQ(lua::GetType(state, -1), lua::LuaType::Table)
        << "The class must be created before creating the instance";
    SetMetaTable(state, -2);
    return instance;
  }

 protected:
  explicit Wrappable(State* state) : internal::WrappableBase(state) {}
  ~Wrappable() override {}

 private:
  DISALLOW_COPY_AND_ASSIGN(Wrappable);
};

// The default type information for any subclass of Wrappable.
template<typename T>
struct Type<T*, typename std::enable_if<std::is_convertible<
                    T*, internal::WrappableBase*>::value>::type> {
  static constexpr const char* name = T::name;
  static inline bool To(State* state, int index, T** out) {
    if (GetType(state, index) != lua::LuaType::UserData ||
        RawLen(state, index) != sizeof(T))
      return false;
    *out = static_cast<T*>(lua_touserdata(state, index));
    return true;
  }
  static inline void Push(State* state, T* wrappable) {
    wrappable->Push(state);
  }
};

}  // namespace lua

#endif  // LUA_WRAPPABLE_H_