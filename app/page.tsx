import PublicDashboard from '@/components/PublicDashboard';

export default function Home() {
  return (
    <div className="flex-1 w-full flex flex-col">
      {/* Dashboard  page with the changes*/}
      <div className="container mx-auto px-4 py-10">
        <PublicDashboard />
      </div>
    </div>
  );
}
