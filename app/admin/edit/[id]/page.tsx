"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Globe, Tag, LinkIcon, Activity, ShieldCheck, Clock, CheckCircle, AlertTriangle, Server, ListFilter, Plus, X } from "lucide-react";
import LoadingSpinner from "@/components/LoadingSpinner";

export default function EditDomain() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const domainId = params?.id;
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [domain, setDomain] = useState<any>(null);
  const [formData, setFormData] = useState({
    domain_name: "",
    display_name: "",
    uptime_url: "",
    category: "none",
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [checkLoading, setCheckLoading] = useState<Record<string, boolean>>({});
  const [checkResults, setCheckResults] = useState<Record<string, { success: boolean; message: string } | null>>({});
  
  // Default categories
  const defaultCategories = [
    "none",
    "Live Website",
    "Live Website Temporary Suspended",
    "Migration Done",
    "Migration Pending",
    "Draft Website",
    "Draft Suspended Website"
  ];
  
  const [categories, setCategories] = useState<string[]>(defaultCategories);
  const [newCategory, setNewCategory] = useState("");
  const [categoryLoading, setCategoryLoading] = useState(false);

  useEffect(() => {
    if (!domainId) return;

    // Load categories from localStorage
    const savedCategories = localStorage.getItem('domain_categories');
    if (savedCategories) {
      try {
        const parsed = JSON.parse(savedCategories);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setCategories(parsed);
        }
      } catch (e) {
        console.error("Error parsing saved categories:", e);
      }
    }
    
    const fetchDomain = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("domains")
          .select("*")
          .eq("id", domainId)
          .single();
        
        if (error) throw error;
        
        setDomain(data);
        
        if (data) {
          setFormData({
            domain_name: data.domain_name || "",
            display_name: data.display_name || "",
            uptime_url: data.uptime_url || "",
            category: data.category || "none",
          });
        }
      } catch (error: any) {
        console.error("Error fetching domain:", error);
        setError("Error loading domain: " + error.message);
      } finally {
        setLoading(false);
      }
    };

    fetchDomain();
  }, [domainId]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const addCategory = () => {
    if (!newCategory.trim()) return;
    
    const trimmedCategory = newCategory.trim();
    if (categories.includes(trimmedCategory)) {
      setError("Category already exists");
      return;
    }
    
    setCategories([...categories, trimmedCategory]);
    setNewCategory("");
    setError("");
  };

  const removeCategory = (categoryToRemove: string) => {
    // Don't allow removing if it's in the default list
    if (defaultCategories.includes(categoryToRemove)) {
      setError("Cannot remove default categories");
      return;
    }
    
    const updatedCategories = categories.filter(cat => cat !== categoryToRemove);
    setCategories(updatedCategories);
    setError("");
    
    // If the removed category was selected, reset to first category
    if (formData.category === categoryToRemove) {
      setFormData(prev => ({ ...prev, category: updatedCategories[0] || "none" }));
    }
  };

  const saveCategories = async () => {
    setCategoryLoading(true);
    try {
      // Save to localStorage
      localStorage.setItem('domain_categories', JSON.stringify(categories));
      setSuccess("Categories saved successfully!");
      setTimeout(() => setSuccess(""), 3000);
    } catch (error: any) {
      setError("Error saving categories: " + error.message);
    } finally {
      setCategoryLoading(false);
    }
  };

  const updateDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    
    // Input validation
    if (!formData.domain_name || !formData.uptime_url) {
      setError("Domain name and uptime URL are required");
      return;
    }

    try {
      setSubmitLoading(true);
      const { error } = await supabase
        .from("domains")
        .update({
          domain_name: formData.domain_name,
          display_name: formData.display_name || null,
          uptime_url: formData.uptime_url,
          category: formData.category,
        })
        .eq("id", domainId);

      if (error) throw error;
      
      setSuccess("Domain updated successfully!");
      
      // After successful update, check the domain status
      triggerCheck('uptime');
      triggerCheck('ssl');
      triggerCheck('whois');
      triggerCheck('ip');
    } catch (error: any) {
      setError(error.message);
    } finally {
      setSubmitLoading(false);
    }
  };

  const triggerCheck = async (type: 'uptime' | 'ssl' | 'whois' | 'ip') => {
    setCheckResults(prev => ({ ...prev, [type]: null }));
    setCheckLoading(prev => ({ ...prev, [type]: true }));
    
    try {
      let endpoint, body;
      
      switch (type) {
        case 'uptime':
          endpoint = '/api/check/uptime';
          body = { domainId: domain.id, url: formData.uptime_url };
          break;
        case 'ssl':
          endpoint = '/api/check/ssl';
          body = { domainId: domain.id, domain: formData.domain_name };
          break;
        case 'whois':
          endpoint = '/api/check/whois';
          body = { domainId: domain.id, domain: formData.domain_name };
          break;
        case 'ip':
          endpoint = '/api/check/ip';
          body = { domainId: domain.id, domain: formData.domain_name };
          break;
      }
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || `Failed to check ${type}`);
      }
      
      let resultMessage = '';
      switch (type) {
        case 'uptime':
          resultMessage = data.status === true ? 'Website is up!' : 'Website is down!';
          break;
        case 'ssl':
          if (data.days_remaining < 0) {
            resultMessage = `SSL expired ${Math.abs(data.days_remaining)} days ago`;
          } else {
            resultMessage = `SSL valid for ${data.days_remaining} days`;
          }
          break;
        case 'whois':
          if (data.days_remaining < 0) {
            resultMessage = `Domain expired ${Math.abs(data.days_remaining)} days ago`;
          } else {
            resultMessage = `Domain expires in ${data.days_remaining} days`;
          }
          break;
        case 'ip':
          resultMessage = `IP: ${data.primary_ip}`;
          break;
      }
      
      setCheckResults(prev => ({ ...prev, [type]: { success: true, message: resultMessage } }));
    } catch (error: any) {
      console.error(`Error checking ${type}:`, error);
      setCheckResults(prev => ({ ...prev, [type]: { success: false, message: error.message } }));
    } finally {
      setCheckLoading(prev => ({ ...prev, [type]: false }));
    }
  };

  const renderCheckButtonContent = (type: 'uptime' | 'ssl' | 'whois' | 'ip', icon: React.ReactNode, text: string) => {
    if (checkLoading[type]) {
      return (
        <>
          <LoadingSpinner size="sm" />
          <span>Checking...</span>
        </>
      );
    }
    
    if (checkResults[type]) {
      return (
        <>
          {checkResults[type]?.success ? (
            <CheckCircle size={16} className="text-green-500" />
          ) : (
            <div className="text-red-500">{icon}</div>
          )}
          <span>{checkResults[type]?.message}</span>
        </>
      );
    }
    
    return (
      <>
        {icon}
        <span>{text}</span>
      </>
    );
  };

  if (loading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="card text-center py-10">
          <LoadingSpinner size="lg" />
          <p className="mt-4 text-muted-foreground">Loading domain information...</p>
        </div>
      </div>
    );
  }

  if (!domain) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="card border-red-300 mb-6 bg-red-50 dark:bg-red-900/10">
          <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
            <AlertTriangle size={18} />
            <p>Domain not found or you don't have permission to edit it.</p>
          </div>
        </div>
        <Link href="/admin" className="btn-outline flex items-center gap-2 w-fit">
          <ChevronLeft size={16} />
          Back to Admin Panel
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="flex items-center mb-6">
        <Link href="/admin" className="btn-outline flex items-center gap-2 mr-4">
          <ChevronLeft size={16} />
          Back to Admin Panel
        </Link>
        <h1 className="text-3xl font-bold">Edit Domain</h1>
      </div>

      {error && (
        <div className="card border-red-300 mb-6 bg-red-50 dark:bg-red-900/10">
          <div className="flex items-center gap-3 text-red-700 dark:text-red-400">
            <AlertTriangle size={18} />
            <p>{error}</p>
          </div>
        </div>
      )}
      
      {success && (
        <div className="card border-green-300 mb-6 bg-green-50 dark:bg-green-900/10">
          <div className="flex items-center gap-3 text-green-700 dark:text-green-400">
            <CheckCircle size={18} />
            <p>{success}</p>
          </div>
        </div>
      )}
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2">
          <form onSubmit={updateDomain} className="card">
            <div className="card-header">
              <h2 className="card-title">Domain Details</h2>
              <p className="card-description">Update information for this domain</p>
            </div>
            
            <div className="space-y-4 mt-6">
              <div>
                <label htmlFor="domain_name" className="block text-sm font-medium text-foreground mb-1">
                  Domain Name*
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <input
                    type="text"
                    id="domain_name"
                    name="domain_name"
                    value={formData.domain_name}
                    onChange={handleInputChange}
                    className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                    required
                  />
                </div>
              </div>
              
              <div>
                <label htmlFor="display_name" className="block text-sm font-medium text-foreground mb-1">
                  Display Name (Optional)
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Tag className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <input
                    type="text"
                    id="display_name"
                    name="display_name"
                    value={formData.display_name}
                    onChange={handleInputChange}
                    className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                  />
                </div>
              </div>
              
              <div>
                <label htmlFor="uptime_url" className="block text-sm font-medium text-foreground mb-1">
                  URL to Check*
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <LinkIcon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <input
                    type="url"
                    id="uptime_url"
                    name="uptime_url"
                    value={formData.uptime_url}
                    onChange={handleInputChange}
                    className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="category" className="block text-sm font-medium text-foreground mb-1">
                  Category
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <ListFilter className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <select
                    id="category"
                    name="category"
                    value={formData.category}
                    onChange={handleSelectChange}
                    className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
                  >
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Category Management Section */}
              <div className="border-t pt-4 mt-4">
                <label className="block text-sm font-medium text-foreground mb-2">
                  Manage Categories
                </label>
                
                {/* Add New Category */}
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCategory();
                      }
                    }}
                    placeholder="Enter new category name"
                    className="flex-1 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background text-sm"
                  />
                  <button
                    type="button"
                    onClick={addCategory}
                    className="btn-secondary flex items-center gap-2 px-4"
                  >
                    <Plus size={16} />
                    Add
                  </button>
                </div>

                {/* Category List */}
                <div className="mb-3">
                  <div className="text-xs text-muted-foreground mb-2">Available Categories:</div>
                  <div className="flex flex-wrap gap-2">
                    {categories.map((cat) => (
                      <span
                        key={cat}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                      >
                        {cat}
                        {!defaultCategories.includes(cat) && (
                          <button
                            type="button"
                            onClick={() => removeCategory(cat)}
                            className="hover:text-red-600 transition-colors"
                            title="Remove category"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Save Categories Button */}
                <button
                  type="button"
                  onClick={saveCategories}
                  disabled={categoryLoading}
                  className="btn-secondary w-full flex items-center justify-center gap-2"
                >
                  {categoryLoading ? (
                    <>
                      <LoadingSpinner size="sm" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle size={16} />
                      <span>Save Category List</span>
                    </>
                  )}
                </button>
              </div>
              
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitLoading}
                  className="btn-brand"
                >
                  {submitLoading ? (
                    <>
                      <LoadingSpinner size="sm" />
                      <span>Updating...</span>
                    </>
                  ) : (
                    "Update Domain"
                  )}
                </button>
              </div>
            </div>
          </form>
        </div>
        
        {/* Manual check panel */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Domain Status</h2>
            <p className="card-description">Run checks for this domain</p>
          </div>
          
          <div className="flex flex-wrap gap-3 mt-4">
            <button
              onClick={() => triggerCheck('uptime')}
              disabled={checkLoading['uptime']}
              className="btn-secondary"
            >
              {renderCheckButtonContent('uptime', <Activity size={16} />, 'Check Uptime')}
            </button>
            
            <button
              onClick={() => triggerCheck('ssl')}
              disabled={checkLoading['ssl']}
              className="btn-secondary"
            >
              {renderCheckButtonContent('ssl', <ShieldCheck size={16} />, 'Check SSL Certificate')}
            </button>
            
            <button
              onClick={() => triggerCheck('whois')}
              disabled={checkLoading['whois']}
              className="btn-secondary"
            >
              {renderCheckButtonContent('whois', <Globe size={16} />, 'Check Domain Expiry')}
            </button>
            
            <button
              onClick={() => triggerCheck('ip')}
              disabled={checkLoading['ip']}
              className="btn-secondary"
            >
              {renderCheckButtonContent('ip', <Server size={16} />, 'Check IP Records')}
            </button>
          </div>
          
          <div className="mt-6 text-xs text-muted-foreground">
            Note: All checks will run automatically when you save changes to the domain.
          </div>
        </div>
      </div>
    </div>
  );
} 