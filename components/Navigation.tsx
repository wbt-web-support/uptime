"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, ChevronsUp, Shield, Home, User, Bell, Gauge } from "lucide-react"; 
import { createClient } from "@/utils/supabase/client";
import { cn } from "@/lib/utils";
import { signOutAction } from "@/app/actions";

export default function Navigation() {
  const [isOpen, setIsOpen] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    async function getUser() {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      setUser(session?.user ?? null);
      setLoading(false);
    }
    getUser();

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [supabase]);

  // Re-check user when pathname changes (e.g., after login redirect)
  useEffect(() => {
    async function checkUser() {
      const { data: { session } } = await supabase.auth.getSession();
      setUser(session?.user ?? null);
    }
    checkUser();
  }, [pathname, supabase]);

  useEffect(() => {
    // Close mobile menu when route changes
    setIsOpen(false);
  }, [pathname]);

  const isActive = (path: string) => {
    return pathname === path;
  };

  const navigationItems = [
    { name: "Home", href: "/", icon: Home, requiredAuth: false },
    { name: "Speed Test", href: "/speed-test", icon: Gauge, requiredAuth: true },
    { name: "Admin", href: "/admin", icon: Shield, requiredAuth: true },
    { name: "Notifications", href: "/admin/notifications", icon: Bell, requiredAuth: true },
  ];

  return (
    <header className="bg-background border-b border-border sticky top-0 z-50">
      <div className="container mx-auto px-4">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center">
            <Link href="/" className="flex items-center space-x-2">
              <div className="w-8 h-8 rounded-full bg-brand flex items-center justify-center">
                <ChevronsUp className="text-white h-5 w-5" />
              </div>
              <span className="font-bold text-xl">Uptime Monitor</span>
            </Link>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex space-x-8 items-center">
            {navigationItems.map((item) => {
              if (item.requiredAuth && !user) return null;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center space-x-1 text-sm font-medium transition-colors",
                    isActive(item.href)
                      ? "text-brand"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.name}</span>
                </Link>
              );
            })}

            {user ? (
              <div className="flex items-center space-x-2">
                <form action={signOutAction}>
                  <button type="submit" className="btn-outline text-sm py-1.5">
                    Sign Out
                  </button>
                </form>
                <div className="w-8 h-8 bg-brand text-white rounded-full flex items-center justify-center">
                  <User className="h-4 w-4" />
                </div>
              </div>
            ) : (
              <Link href="/sign-in" className="btn-brand text-sm">
                Sign In
              </Link>
            )}
          </nav>

          {/* Mobile menu button */}
          <div className="md:hidden">
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="inline-flex items-center justify-center p-2 rounded-md text-foreground hover:text-brand hover:bg-secondary transition-colors"
            >
              <span className="sr-only">{isOpen ? "Close menu" : "Open menu"}</span>
              {isOpen ? (
                <X className="block h-6 w-6" aria-hidden="true" />
              ) : (
                <Menu className="block h-6 w-6" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Navigation */}
      {isOpen && (
        <div className="md:hidden animate-fade-in">
          <div className="px-2 pt-2 pb-3 space-y-1 bg-background border-t border-border">
            {navigationItems.map((item) => {
              if (item.requiredAuth && !user) return null;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center space-x-3 px-3 py-2 rounded-md text-base font-medium",
                    isActive(item.href)
                      ? "bg-brand/10 text-brand"
                      : "text-foreground hover:bg-secondary hover:text-brand"
                  )}
                >
                  <item.icon className="h-5 w-5" />
                  <span>{item.name}</span>
                </Link>
              );
            })}

            {user ? (
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center space-x-3">
                  <div className="w-8 h-8 bg-brand text-white rounded-full flex items-center justify-center">
                    <User className="h-4 w-4" />
                  </div>
                  <span className="text-sm truncate max-w-[150px]">
                    {user.email}
                  </span>
                </div>
                <form action={signOutAction}>
                  <button type="submit" className="btn-outline text-xs py-1">
                    Sign Out
                  </button>
                </form>
              </div>
            ) : (
              <Link
                href="/sign-in"
                className="flex items-center space-x-3 px-3 py-2 rounded-md text-base font-medium text-brand hover:bg-brand/10"
              >
                <User className="h-5 w-5" />
                <span>Sign In</span>
              </Link>
            )}
          </div>
        </div>
      )}
    </header>
  );
} 