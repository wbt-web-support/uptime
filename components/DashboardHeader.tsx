import { Search, Filter, Tag } from 'lucide-react';
import { wrap } from 'module';
import { ReactNode } from 'react';

interface DashboardHeaderProps {
  title: string;
  description?: string;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  statusFilter: string;
  setStatusFilter: (filter: string) => void;
  categoryFilter?: string;
  setCategoryFilter?: (filter: string) => void;
  categories?: string[];
  totalCount: number;
  filteredCount: number;
  isAdmin?: boolean;
  rightContent?: ReactNode;
  stats?: {
    total: number;
    up: number;
    down: number;
    sslExpiring: number;
    domainExpiring: number;
  };
}

export default function DashboardHeader({
  title,
  description,
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  categoryFilter = 'all',
  setCategoryFilter = () => {},
  categories = ['all'],
  totalCount,
  filteredCount,
  isAdmin = false,
  rightContent,
  stats
}: DashboardHeaderProps) {
  const filters = [
    { id: 'all', name: 'All', color: 'bg-brand', count: stats?.total },
    { id: 'up', name: 'Operational', color: 'bg-green-500', count: stats?.up },
    { id: 'down', name: 'Down', color: 'bg-red-500', count: stats?.down },
    { id: 'ssl-expiring', name: 'SSL Expiring', color: 'bg-amber-500', count: stats?.sslExpiring },
    { id: 'domain-expiring', name: 'Domain Expiring', color: 'bg-orange-500', count: stats?.domainExpiring }
  ];

  return (
    <div className="mb-8 animate-fade-in">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
        <div className="flex items-center gap-2 w-full justify-between flex-col lg:flex-row">

          <div className="flex items-center flex-col gap-1 items-start text-left">

          <h1 className="text-3xl font-bold text-foreground w-full">{title}</h1>
          {description && <p className="text-muted-foreground mt-1 text-left w-full">{description}</p>}
          <div className="text-sm text-muted-foreground text-left w-full">
            Showing {filteredCount} of {totalCount} domains
          </div>
          </div>

          <div className="lg:col-span-1 relative w-full lg:w-auto">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-4 w-4 text-muted-foreground" />
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search domains..."
            className="w-full pl-10 py-2 px-3 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors bg-background"
          />
        </div>


        </div>
        
        {isAdmin && !rightContent && (
          <div>
            <button 
              className="btn-brand"
              style={{textWrap: 'nowrap'}}
              onClick={() => document.getElementById('add-domain-form')?.scrollIntoView({ behavior: 'smooth' })}
            >
              Add New Domain
            </button>
          </div>
        )}

        {rightContent && (
          <div>
            {rightContent}
          </div>
        )}
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
       
        
        <div className="lg:col-span-2 flex flex-wrap gap-2 items-center">
          <span className="flex items-center text-sm font-medium text-muted-foreground mr-2">
            <Filter className="mr-2 h-4 w-4" />
            Filter:
          </span>
          
          {filters.map((filter) => (
            <button
              key={filter.id}
              onClick={() => setStatusFilter(filter.id)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                statusFilter === filter.id
                  ? `${filter.color} text-white shadow-sm`
                  : 'bg-secondary text-foreground hover:bg-secondary/70'
              }`}
            >
              {filter.name}
              {filter.count !== undefined && (
                <span className={`ml-2 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-xs font-semibold ${
                  statusFilter === filter.id ? 'bg-white/20 text-white' : 'bg-background/50 text-muted-foreground'
                }`}>
                  {filter.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Category filters */}
      {categories.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-2 items-center">
          <span className="flex items-center text-sm font-medium text-muted-foreground mr-2">
            <Tag className="mr-2 h-4 w-4" />
            Categories:
          </span>
          
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setCategoryFilter(category)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                categoryFilter === category
                  ? 'bg-brand text-white shadow-sm'
                  : 'bg-secondary text-foreground hover:bg-secondary/70'
              }`}
            >
              {category === 'all' ? 'All' : category}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}